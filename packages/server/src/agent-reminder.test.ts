import { describe, expect, test } from "bun:test"
import { postCompactionReminder } from "./agent.ts"
import { HumanMessage } from "@langchain/core/messages"
const summary = () => new HumanMessage({ content: "summary", additional_kwargs: { lc_source: "summarization" } })
const stale = () => new HumanMessage({ content: "stale", additional_kwargs: { lc_source: "chunky-system-reminder" } })

describe("post-compaction reminder", () => {
  test("requires summary and replaces stale reminder immediately after it", async () => {
    const result = await postCompactionReminder({ messages: [new HumanMessage("old"), summary(), stale()] }, { configurable: { thread_id: "s" } }, () => ({ goal: { objective: "live", status: "active", mode: "direct", turns: 1, maxTurns: 2 } }))
    expect(result?.messages[1].additional_kwargs.lc_source).toBe("summarization")
    expect(result?.messages[2].content).toContain("live")
    expect(result?.messages.filter((m: any) => m.additional_kwargs?.lc_source === "chunky-system-reminder")).toHaveLength(1)
    expect(await postCompactionReminder({ messages: [new HumanMessage("x")] }, { configurable: { thread_id: "s" } }, () => ({ goal: { objective: "no", status: "active", mode: "direct", turns: 1, maxTurns: 2 } }))).toBeUndefined()
  })
  test("does not inject when live state is empty", async () => {
    const result = await postCompactionReminder({ messages: [summary(), stale()] }, { configurable: { thread_id: "s" } }, () => ({}))
    expect(result?.messages).toHaveLength(1)
    expect(result?.messages[0].additional_kwargs.lc_source).toBe("summarization")
  })
})
