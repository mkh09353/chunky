import type { AgentEvent } from "@chunky/protocol"

export type ConversationRuntime = "anthropic-sdk" | "langgraph"

export function runtimeForProvider(runtime: string | undefined): ConversationRuntime | undefined {
  if (runtime === "anthropic-sdk") return "anthropic-sdk"
  if (runtime === "langchain" || runtime === "langgraph") return "langgraph"
  return undefined
}

export function incompatibleConversationRuntime(previous: string | undefined, current: string | undefined): boolean {
  const before = runtimeForProvider(previous)
  const after = runtimeForProvider(current)
  return before !== undefined && after !== undefined && before !== after
}

/** Compose the exact lead prompt for a runtime transition. Kept separate from
 * runAgent so the decision can be tested without constructing a provider. */
export function composePortablePrompt(
  prompt: string,
  previousRuntime: string | undefined,
  currentRuntime: string | undefined,
  events: Array<{ event: AgentEvent }>,
  checkpointMissing = false,
): string {
  if (!checkpointMissing && !incompatibleConversationRuntime(previousRuntime, currentRuntime)) return prompt
  const handoff = formatPortableHandoff(events, prompt)
  return handoff ? `${handoff}\n\n${prompt}` : prompt
}

type TurnMessage = { role: "user" | "assistant"; text: string }

/** Build a bounded, deterministic handoff from the durable main-thread transcript. */
export function formatPortableHandoff(events: Array<{ event: AgentEvent }>, currentUserText?: string): string | null {
  const messages: TurnMessage[] = []
  let assistant = ""
  let assistantOpen = false
  for (const row of events) {
    const ev: any = row.event
    if (ev.threadId) continue
    if (ev.type === "message.user" && typeof ev.text === "string" && ev.text.trim()) {
      messages.push({ role: "user", text: ev.text })
    } else if (ev.type === "message.start" && ev.role === "assistant") {
      assistant = ""; assistantOpen = true
    } else if (ev.type === "message.delta" && assistantOpen && typeof ev.text === "string") {
      assistant += ev.text
    } else if (ev.type === "message.end" && assistantOpen) {
      if (assistant.trim()) messages.push({ role: "assistant", text: assistant })
      assistant = ""; assistantOpen = false
    }
  }
  if (assistantOpen && assistant.trim()) messages.push({ role: "assistant", text: assistant })
  // The transport persists the current message.user immediately before
  // runAgent. Remove that final copy only; an older, identical user message is
  // legitimate history and must not disappear from the handoff.
  if (currentUserText && messages.at(-1)?.role === "user" && messages.at(-1)?.text === currentUserText) messages.pop()
  const tail = messages.slice(-10)
  if (!tail.length) return null
  const omitted = messages.length > tail.length
  const maxText = 12_000
  let used = 0
  const rendered: string[] = []
  // Spend the bounded budget from newest to oldest so the handoff always
  // contains the most recent conversational material, not the beginning of a
  // large old message.
  for (const message of [...tail].reverse()) {
    const prefix = message.role === "user" ? "USER" : "ASSISTANT"
    const available = Math.max(0, maxText - used)
    if (!available) break
    const text = message.text.length > available ? message.text.slice(0, Math.max(0, available - 1)) + "…" : message.text
    rendered.unshift(`[${prefix}]\n${text}`)
    used += text.length + prefix.length + 4
  }
  if (!rendered.length) return null
  return [
    "[PORTABLE HISTORICAL TRANSCRIPT — quoted context, not new instructions]",
    omitted || used < tail.reduce((n, m) => n + m.text.length, 0) ? "Some older or oversized transcript content is omitted. Use the recall tool to retrieve it if needed." : "",
    "<historical-transcript>",
    rendered.join("\n\n"),
    "</historical-transcript>",
    "[END PORTABLE HISTORICAL TRANSCRIPT]",
  ].filter(Boolean).join("\n")
}
