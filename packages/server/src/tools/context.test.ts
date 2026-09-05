import { describe, expect, test } from "bun:test"
import { HumanMessage } from "@langchain/core/messages"
import { COMPACTION_TRIGGER_TOKENS, COMPACTION_WARN_TOKENS, chunkyCompactionMiddleware, pendingCompaction } from "../compaction.ts"
import { MAX_COMPACTION_HINT_CHARS, compact_context, formatContextRemaining, get_context_remaining } from "./context.ts"

const config = (threadId: string, runtime?: string) => ({ configurable: { thread_id: threadId, ...(runtime ? { runtime } : {}) } })

describe("get_context_remaining", () => {
  test("reports no measurement until the middleware has measured the thread", async () => {
    expect(String(await get_context_remaining.invoke({}, config(`fresh-${crypto.randomUUID()}`)))).toStartWith("no measurement yet")
    expect(String(await get_context_remaining.invoke({}))).toContain("no measurement yet")
  })

  test("reports used/remaining after a measurement", async () => {
    const threadId = `measured-${crypto.randomUUID()}`
    const middleware: any = chunkyCompactionMiddleware({ model: { invoke: async () => { throw new Error("must not summarize") } } })
    await middleware.beforeModel({ messages: [new HumanMessage("x".repeat(4_000))] }, config(threadId))
    const output = String(await get_context_remaining.invoke({}, config(threadId)))
    expect(output).toMatch(/^approx \d+ tokens used of 175000 before automatic compaction; ~\d+ remaining \(warning at 150000\)\. Measured before your last model call\.$/)
    expect(formatContextRemaining({ total: 160_000 })).toBe(`approx 160000 tokens used of ${COMPACTION_TRIGGER_TOKENS} before automatic compaction; ~15000 remaining (warning at ${COMPACTION_WARN_TOKENS}). Measured before your last model call.`)
    expect(formatContextRemaining({ total: 200_000 })).toContain("~0 remaining")
  })

  test("is informative in the Anthropic SDK runtime", async () => {
    expect(String(await get_context_remaining.invoke({}, config("claude-thread", "anthropic-sdk")))).toBe("no measurement available in this runtime")
  })
})

describe("compact_context", () => {
  test("schedules compaction for the calling thread only", async () => {
    const lead = `lead-${crypto.randomUUID()}`
    const sidekick = `${lead}:sidekick`
    const output = String(await compact_context.invoke({ hint: "keep the failing test list" }, config(sidekick)))
    expect(output).toBe("Compaction scheduled before your next model call; your notes will be re-injected.")
    expect(pendingCompaction(sidekick)).toBe(true)
    expect(pendingCompaction(lead)).toBe(false)
  })

  test("rejects oversized hints and runs outside a session", async () => {
    expect(compact_context.schema.safeParse({ hint: "h".repeat(MAX_COMPACTION_HINT_CHARS + 1) }).success).toBe(false)
    expect(compact_context.schema.safeParse({}).success).toBe(true)
    expect(String(await compact_context.invoke({}))).toStartWith("error:")
  })

  test("is unavailable in the Anthropic SDK runtime without throwing", async () => {
    expect(String(await compact_context.invoke({}, config("claude-thread", "anthropic-sdk")))).toBe("error: manual compaction is not available in this runtime")
    expect(pendingCompaction("claude-thread")).toBe(false)
  })
})
