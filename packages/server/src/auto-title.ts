import type { BaseChatModel } from "@langchain/core/language_models/chat_models"
import type { AgentEvent } from "@chunky/protocol"
import { isIncognitoSession } from "./incognito.ts"
import { effectiveSessionSelection } from "./run.ts"
import { resolveModel, sidekickFor } from "./providers/registry.ts"
import { Store } from "./store.ts"

type Invoke = (model: BaseChatModel, messages: Array<{ role: "system" | "user"; content: string }>) => Promise<unknown>
let invokeModel: Invoke = async (model, messages) => model.invoke(messages)

export function setAutoTitleInvokerForTests(invoker: Invoke | null): void {
  invokeModel = invoker ?? (async (model, messages) => model.invoke(messages))
}

const inflight = new Set<string>()
const SYSTEM = "Generate a concise session title. Return only 3-6 words, no quotes, punctuation, markdown, or explanation."

function textOf(value: unknown): string {
  const content = (value as { content?: unknown })?.content
  if (typeof content === "string") return content
  if (Array.isArray(content)) return content.map((x) => typeof x === "string" ? x : (x as { text?: string })?.text ?? "").join("")
  return typeof value === "string" ? value : ""
}

export function normalizeAutoTitle(value: unknown): string {
  return textOf(value).replace(/[\r\n]+/g, " ").replace(/["'`]+/g, "").replace(/[^\p{L}\p{N}\s-]/gu, "").replace(/\s+/g, " ").trim().slice(0, 60)
}

function promptFor(sessionId: string): string | null {
  let user = ""
  let assistant = ""
  for (const ev of Store.history(sessionId)) {
    if ("threadId" in ev && ev.threadId) continue
    if (!user && ev.type === "message.user") user = ev.text
    if (ev.type === "message.delta" && assistant.length < 3500) assistant += ev.text
  }
  if (!user && !assistant) return null
  return `First user request:\n${user.slice(0, 1800)}\n\nAssistant response:\n${assistant.slice(0, 3500)}`
}

/** Generate and publish one title without becoming part of turn cleanup. */
export async function autoTitleSession(sessionId: string, turn: number, emit: (ev: AgentEvent) => void): Promise<void> {
  if (turn !== 1 && turn !== 2 || inflight.has(sessionId) || !Store.exists(sessionId) || isIncognitoSession(sessionId) || !Store.canAutoTitle(sessionId)) return
  const input = promptFor(sessionId)
  if (!input) return
  inflight.add(sessionId)
  try {
    const selection = effectiveSessionSelection(sessionId)
    const cheap = sidekickFor(selection, sessionId) ?? selection
    const result = await invokeModel(resolveModel(cheap, sessionId), [{ role: "system", content: SYSTEM }, { role: "user", content: input }])
    const title = normalizeAutoTitle(result)
    if (title && Store.setAutoTitle(sessionId, title)) emit({ type: "session.title", sessionId, title })
  } catch {
    // Auto-titling is best effort and must never affect the completed turn.
  } finally {
    inflight.delete(sessionId)
  }
}

export function autoTitleInFlight(sessionId: string): boolean { return inflight.has(sessionId) }
