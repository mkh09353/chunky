import { HumanMessage, RemoveMessage, ToolMessage, AIMessage } from "@langchain/core/messages"
import { REMOVE_ALL_MESSAGES } from "@langchain/langgraph"
import { createMiddleware, countTokensApproximately } from "langchain"

export const COMPACTION_TRIGGER_TOKENS = 175_000
export const COMPACTION_KEEP_MESSAGES = 15
export const MIN_SUMMARY_CHARS = 200
const RETRY_DELAY_MS = 25

export const CHUNKY_COMPACTION_PROMPT = `You are compacting a Chunky agent conversation for a successor assistant. Produce a faithful, tight summary that preserves the information needed to continue the work.

If the history contains a prior compaction summary, treat it as authoritative for the early history and fold all still-relevant information forward. The full unabridged transcript remains searchable via the recall tool. Do not inline long evidence: reference it by topic keyword, for example "full stack trace: recall query 'TypeError hydrate'", and keep prose tight.

A focused summary that fits is more useful than an exhaustive one — aim for at most a few thousand words.

Use every section below, writing "None" when empty:
1. Primary Request and Intent
2. Key Technical Concepts
3. Files and Code Sections (paths + why they matter)
4. Errors and Fixes
5. Problem Solving (done vs in progress)
6. All User Messages (every user ask, condensed)
7. Pending Tasks
8. Current Work
9. Next Step

Do NOT call tools; respond with ONLY the <summary>...</summary> block.`

function contentOf(message: any): string {
  if (typeof message?.content === "string") return message.content
  try { return JSON.stringify(message?.content ?? "") } catch { return String(message?.content ?? "") }
}

export function cleanSummary(raw: string): { text: string; degenerate: boolean } {
  let text = raw.trim()
  while (text.startsWith("<analysis>")) {
    const end = text.indexOf("</analysis>", 10)
    if (end < 0) { text = ""; break }
    text = text.slice(end + 11).trim()
  }
  const open = text.indexOf("<summary>")
  const close = text.lastIndexOf("</summary>")
  if (open < 0 || close <= open) return { text: text.trim(), degenerate: true }
  text = text.slice(0, open) + text.slice(open + 9, close) + text.slice(close + 10)
  text = text.trim()
  text = text.replace(/<\/?(summary|analysis|system-reminder|user_query|conversation_summary|tool_call[^>]*)>/gi, (tag) => tag.replace("<", "<\u200b"))
  text = `Summary of earlier conversation:\n${text}`.trim()
  return { text, degenerate: text.length < MIN_SUMMARY_CHARS }
}

function tailBoundary(messages: any[]): number {
  let boundary = Math.max(0, messages.length - COMPACTION_KEEP_MESSAGES)
  for (let i = boundary; i < messages.length; i++) {
    const m = messages[i]
    if (!(m instanceof ToolMessage) && m?._getType?.() !== "tool") continue
    const id = m.tool_call_id ?? m.additional_kwargs?.tool_call_id
    if (!id) continue
    for (let j = boundary - 1; j >= 0; j--) {
      const prior = messages[j]
      const calls = prior?.tool_calls ?? prior?.additional_kwargs?.tool_calls
      if (prior instanceof AIMessage || prior?._getType?.() === "ai") {
        if (Array.isArray(calls) && calls.some((call: any) => call.id === id)) boundary = Math.min(boundary, j)
        break
      }
    }
  }
  return boundary
}

export function chunkyCompactionMiddleware({ model }: { model: any }) {
  return createMiddleware({
    name: "ChunkyCompactionMiddleware",
    beforeModel: async (state: { messages: any[] }, runtime: any) => {
      const messages = state.messages
      const total = await countTokensApproximately(messages)
      if (total < COMPACTION_TRIGGER_TOKENS) return
      const boundary = tailBoundary(messages)
      if (boundary <= 0) return
      const oldMessages = messages.slice(0, boundary)
      const prompt = `${CHUNKY_COMPACTION_PROMPT}\n\n<messages>\n${oldMessages.map((m) => `${m._getType?.() ?? "message"}: ${contentOf(m)}`).join("\n")}\n</messages>`
      let cleaned: { text: string; degenerate: boolean } | undefined
      let lastReason = "summary was empty or malformed"
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const response = await model.invoke(prompt)
          const raw = typeof response?.content === "string" ? response.content : Array.isArray(response?.content) ? response.content.map((x: any) => typeof x === "string" ? x : x?.text ?? "").join("") : String(response?.content ?? response ?? "")
          cleaned = cleanSummary(raw)
          if (!cleaned.degenerate) break
          lastReason = "summary was degenerate"
        } catch (error) { lastReason = error instanceof Error ? error.message : String(error) }
        if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS))
      }
      if (!cleaned || cleaned.degenerate) {
        const sessionId = runtime?.configurable?.thread_id
        const emit = runtime?.configurable?.emitSessionEvent
        if (typeof emit === "function" && typeof sessionId === "string") emit({ type: "context.compaction_failed", sessionId, reason: lastReason })
        console.warn(`[chunky] compaction failed: ${lastReason}`)
        return
      }
      const summary = new HumanMessage({ id: crypto.randomUUID(), content: cleaned.text, additional_kwargs: { lc_source: "summarization" } })
      return { messages: [new RemoveMessage({ id: REMOVE_ALL_MESSAGES }), summary, ...messages.slice(boundary)] }
    },
  })
}
