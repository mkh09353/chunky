import { describe, expect, test } from "bun:test"
import { makePostCompactionReminder } from "./agent.ts"
import { HumanMessage, SystemMessage } from "@langchain/core/messages"
import { messagesStateReducer } from "@langchain/langgraph"

const summary = (id: string) => new HumanMessage({ id, content: "summary", additional_kwargs: { lc_source: "summarization" } })
const stale = (id: string) => new SystemMessage({ id, content: "stale", additional_kwargs: { lc_source: "chunky-system-reminder" } })
const live = () => ({ goal: { objective: "live", status: "active", mode: "direct", turns: 1, maxTurns: 2 } })

describe("post-compaction reminder", () => {
  test("emits reducer removals and one reminder, then ignores the same summary", async () => {
    const middleware = makePostCompactionReminder()
    const result = await middleware({ messages: [new HumanMessage("old"), summary("sum-1"), stale("old-reminder")] }, { configurable: { thread_id: "s" } }, live)
    expect(result?.messages).toHaveLength(2)
    expect(result?.messages[0]).toMatchObject({ type: "remove", id: "old-reminder" })
    expect(result?.messages[1]).toBeInstanceOf(SystemMessage)
    expect((result?.messages[1] as SystemMessage).content).toContain("live")
    expect((result?.messages[1] as SystemMessage).content).toContain("full unabridged transcript remains available via recall")
    expect(await middleware({ messages: [summary("sum-1")] }, { configurable: { thread_id: "s" } }, () => ({}))).toBeUndefined()
  })
  test("new summary removes every prior reminder and inserts one fresh reminder", async () => {
    const middleware = makePostCompactionReminder()
    await middleware({ messages: [summary("sum-1")] }, { configurable: { thread_id: "s" } }, live)
    const result = await middleware({ messages: [summary("sum-2"), stale("r1"), stale("r2")] }, { configurable: { thread_id: "s" } }, live)
    expect(result?.messages.filter((m: any) => m.type === "remove")).toHaveLength(2)
    expect(result?.messages.filter((m: any) => m.additional_kwargs?.lc_source === "chunky-system-reminder")).toHaveLength(1)
    const reduced = messagesStateReducer([summary("sum-2"), stale("r1"), stale("r2")], result!.messages)
    expect(reduced.filter((m) => m.additional_kwargs?.lc_source === "chunky-system-reminder")).toHaveLength(1)
    expect(reduced.some((m) => m.id === "r1" || m.id === "r2")).toBe(false)
  })
  test("a reminder already answering the summary in state counts as handled across threads and rebuilt agents", async () => {
    const middleware = makePostCompactionReminder()
    const first = await middleware({ messages: [summary("sum-a")] }, { configurable: { thread_id: "a" } }, live)
    const reminderA = first!.messages[0] as SystemMessage
    expect(reminderA.additional_kwargs.lc_for_summary).toBe("sum-a")
    // Another thread compacts on the same cached agent instance...
    expect(await middleware({ messages: [summary("sum-b")] }, { configurable: { thread_id: "b" } }, live)).toBeDefined()
    // ...then thread A calls again: its summary was already answered, so nothing is re-emitted.
    let emitted = 0
    expect(await middleware({ messages: [summary("sum-a"), reminderA] }, { configurable: { thread_id: "a", emitSessionEvent: () => { emitted++ } } }, live)).toBeUndefined()
    expect(emitted).toBe(0)
    expect(await makePostCompactionReminder()({ messages: [summary("sum-a"), reminderA] }, { configurable: { thread_id: "a" } }, live)).toBeUndefined()
  })
  test("removes stale reminders and injects recall guidance when live state is empty", async () => {
    const middleware = makePostCompactionReminder()
    const result = await middleware({ messages: [summary("sum-empty"), stale("r-empty")] }, { configurable: { thread_id: "s" } }, () => ({}))
    expect(result?.messages).toHaveLength(2)
    expect(result?.messages[0]).toMatchObject({ type: "remove", id: "r-empty" })
    expect((result?.messages[1] as SystemMessage).content).toContain("recall")
  })
})
