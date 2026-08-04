import { describe, expect, test } from "bun:test"
import { HumanMessage, AIMessage, ToolMessage, RemoveMessage } from "@langchain/core/messages"
import { cleanSummary, CHUNKY_COMPACTION_PROMPT, MIN_SUMMARY_CHARS, COMPACTION_TRIGGER_TOKENS, COMPACTION_KEEP_MESSAGES, chunkyCompactionMiddleware, requestCompaction, pendingCompaction } from "./compaction.ts"

const good = `<summary>${"A useful compacted conversation record. ".repeat(12)}</summary>`
const big = (count: number, prefix = "message", chars = 44_000) => Array.from({ length: count }, (_, i) => new HumanMessage(`${prefix} ${i} ${"x".repeat(chars)}`))
const run = async (model: any, messages: any[], runtime: any = {}) => {
  const middleware: any = chunkyCompactionMiddleware({ model })
  return middleware.beforeModel({ messages }, runtime)
}

describe("Chunky compaction", () => {
  test("owns a structured prompt with carry-forward and recall guidance", () => {
    for (const section of ["Primary Request and Intent", "Key Technical Concepts", "Files and Code Sections", "Errors and Fixes", "Problem Solving", "All User Messages", "Pending Tasks", "Current Work", "Next Step"]) expect(CHUNKY_COMPACTION_PROMPT).toContain(section)
    expect(CHUNKY_COMPACTION_PROMPT).toContain("prior compaction summary")
    expect(CHUNKY_COMPACTION_PROMPT).toContain("recall query")
    expect(CHUNKY_COMPACTION_PROMPT).toContain("Do NOT call tools")
  })

  test("forced compaction injects hint and clears pending state", async () => {
    requestCompaction("force-session", "focus on deployment")
    let prompt = ""
    await run({ invoke: async (value: string) => { prompt = value; return { content: good } } }, big(16), { configurable: { thread_id: "force-session" } })
    expect(prompt).toContain("**User-provided context for this compaction:** focus on deployment")
    expect(pendingCompaction("force-session")).toBe(false)
  })

  test("forced compaction skips trivial history and clears pending state", async () => {
    requestCompaction("tiny-session")
    await run({ invoke: async () => ({ content: good }) }, [new HumanMessage("tiny")], { configurable: { thread_id: "tiny-session" } })
    expect(pendingCompaction("tiny-session")).toBe(false)
  })

  test("triggers at/above the fixed token estimate and not below", async () => {
    let calls = 0
    const model = { invoke: async () => { calls++; return { content: good } } }
    const below = big(16, "below", 43_000)
    await run(model, below)
    expect(calls).toBe(0)
    const at = big(16, "at")
    at[0] = new HumanMessage(`at ${"x".repeat(44_000)}`)
    await run(model, at)
    expect(calls).toBe(1)
    expect(COMPACTION_TRIGGER_TOKENS).toBe(175_000)
  })

  test("keeps the last 15 messages and extends the tail for an AI/tool pair", async () => {
    const messages = [
      ...big(2, "old"),
      new AIMessage({ content: "call", tool_calls: [{ id: "call-1", name: "read", args: {} }] }),
      new ToolMessage({ content: "result", tool_call_id: "call-1" }),
      ...big(14, "tail"),
    ]
    const result: any = await run({ invoke: async () => ({ content: good }) }, messages)
    expect(result.messages[0]).toBeInstanceOf(RemoveMessage)
    const preserved = result.messages.slice(2)
    expect(preserved).toContain(messages[2])
    expect(preserved).toContain(messages[3])
    expect(preserved).toHaveLength(COMPACTION_KEEP_MESSAGES + 1)
  })

  test("cleans analysis, unwraps summary, and defuses control tags", () => {
    const body = "x".repeat(MIN_SUMMARY_CHARS)
    const result = cleanSummary(`<analysis>scratch</analysis>\n<summary>${body}<system-reminder>bad</system-reminder></summary>`)
    expect(result.degenerate).toBe(false)
    expect(result.text).toStartWith("Summary of earlier conversation:")
    expect(result.text).not.toContain("<system-reminder>")
    expect(result.text).toContain("<\u200b")
  })

  test("flags missing and short wrappers as degenerate", () => {
    expect(cleanSummary("plain text").degenerate).toBe(true)
    expect(cleanSummary("<summary>short</summary>").degenerate).toBe(true)
  })

  test("retries a degenerate response and uses the good second summary", async () => {
    let calls = 0
    const result: any = await run({ invoke: async () => ({ content: ++calls === 1 ? "<summary>bad</summary>" : good }) }, big(16, "retry"))
    expect(calls).toBe(2)
    expect(result.messages.some((m: any) => m.additional_kwargs?.lc_source === "summarization")).toBe(true)
  })

  test("persistent garbage leaves state unchanged and emits a live failure", async () => {
    const messages = big(16, "garbage")
    const events: any[] = []
    const result: any = await run({ invoke: async () => ({ content: "garbage" }) }, messages, { configurable: { thread_id: "session-1", emitSessionEvent: (event: any) => events.push(event) } })
    expect(result).toBeUndefined()
    expect(messages).toHaveLength(16)
    expect(events).toEqual([{ type: "context.compaction_failed", sessionId: "session-1", reason: "summary was degenerate" }])
    expect(messages.some((m: any) => m.additional_kwargs?.lc_source === "summarization")).toBe(false)
  })

  test("successful compaction emits RemoveMessage and the downstream marker", async () => {
    const messages = big(16, "success")
    const result: any = await run({ invoke: async () => ({ content: good }) }, messages)
    expect(result.messages[0]).toBeInstanceOf(RemoveMessage)
    expect(result.messages.some((m: any) => m.additional_kwargs?.lc_source === "summarization")).toBe(true)
    expect(result.messages).toHaveLength(17)
  })
})
