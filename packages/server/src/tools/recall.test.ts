import { describe, expect, test } from "bun:test"
import type { AgentEvent } from "@chunky/protocol"
import {
  MAX_BYTES,
  RANGE_EVENT_MAX,
  coalesceRecallDeltas,
  filterRecallEvents,
  recall,
  recallEventText,
  renderRecallEvents,
  type TranscriptRow,
} from "./recall.ts"

const row = (seq: number, event: AgentEvent): TranscriptRow => ({ seq, event })

describe("recall transcript helpers", () => {
  test("maps readable event types and omits UI-only events", () => {
    expect(recallEventText({ type: "message.user", text: "hello", from: "other" })).toEqual({ speaker: "user from other", text: "hello" })
    expect(recallEventText({ type: "tool.start", id: "t", name: "bash", input: { command: "pwd" } })).toEqual({ speaker: "tool bash", text: 'input: {"command":"pwd"}' })
    expect(recallEventText({ type: "tool.end", id: "t", ok: false, output: "nope" })).toEqual({ speaker: "tool", text: "error: nope" })
    expect(recallEventText({ type: "session.status", sessionId: "s", status: "idle" })).toBeNull()
  })

  test("coalesces adjacent same-type deltas for one thread, retaining seq span", () => {
    const rows = coalesceRecallDeltas([
      row(142, { type: "message.delta", text: "hel", threadId: "main" }),
      row(143, { type: "message.delta", text: "lo", threadId: "main" }),
      row(144, { type: "message.delta", text: " child", threadId: "child" }),
      row(145, { type: "reasoning.delta", text: "why", threadId: "child" }),
      row(146, { type: "reasoning.delta", text: " now", threadId: "child" }),
    ])
    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatchObject({ seq: 142, endSeq: 143, event: { text: "hello" } })
    expect(rows[2]).toMatchObject({ seq: 145, endSeq: 146, event: { text: "why now" } })
    expect(renderRecallEvents(rows, false)).toContain("[142-143 assistant] hello")
  })

  test("searches coalesced text with case-insensitive regex and literal fallback", () => {
    const rows = [
      row(1, { type: "message.delta", text: "Deploy ", threadId: "a" }),
      row(2, { type: "message.delta", text: "GREEN", threadId: "a" }),
      row(3, { type: "message.user", text: "literal [bracket" }),
    ]
    expect(filterRecallEvents(rows, { query: "deploy green" })).toHaveLength(1)
    expect(filterRecallEvents(rows, { query: "DEPL.Y\\s+green" })).toHaveLength(1)
    expect(filterRecallEvents(rows, { query: "[bracket" })).toHaveLength(1)
  })

  test("range paging is inclusive and intersects a coalesced delta span", () => {
    const rows = [row(10, { type: "message.delta", text: "a" }), row(11, { type: "message.delta", text: "b" }), row(12, { type: "message.user", text: "next" })]
    expect(filterRecallEvents(rows, { seqStart: 11, seqEnd: 11 })).toMatchObject([{ seq: 10, endSeq: 11 }])
    expect(filterRecallEvents(rows, { seqStart: 12, seqEnd: 12 })).toMatchObject([{ seq: 12 }])
  })

  test("composes tool and query filters", () => {
    const rows = [row(1, { type: "tool.start", id: "a", name: "edit", input: { path: "a.ts" } }), row(2, { type: "tool.end", id: "a", ok: true, output: "ok" }), row(3, { type: "tool.start", id: "b", name: "write", input: { file_path: "b.ts" } })]
    expect(filterRecallEvents(rows, { tool: "edit", query: "a.ts" })).toHaveLength(1)
    expect(filterRecallEvents(rows, { speaker: "tool" })).toHaveLength(3)
  })

  test("filters by turn boundaries and before-compaction sequence", () => {
    const rows = [row(1, { type: "message.user", text: "old" }), row(2, { type: "message.delta", text: "answer" }), row(3, { type: "context.compacted", sessionId: "s" }), row(4, { type: "message.user", text: "new" })]
    expect(filterRecallEvents(rows, { seqStart: 1, seqEnd: 2 })).toHaveLength(2)
    expect(filterRecallEvents(rows, { beforeSeq: 3 })).toHaveLength(2)
  })

  test("truncates individual events and caps total output", () => {
    const long = "x".repeat(RANGE_EVENT_MAX + 20)
    expect(renderRecallEvents([row(1, { type: "message.user", text: long })], false)).toContain("…")
    const many = Array.from({ length: 20 }, (_, i) => row(i, { type: "message.user" as const, text: "y".repeat(RANGE_EVENT_MAX) }))
    const output = renderRecallEvents(many, false)
    expect(output).toContain("[output capped")
    expect(output.length).toBeLessThanOrEqual(MAX_BYTES + 100)
  })
})

describe("recall tool validation", () => {
  test("rejects missing query and seq_start through its schema", () => {
    expect(recall.schema.safeParse({}).success).toBe(false)
  })

  test("reports an unknown requested session", async () => {
    const output = await recall.invoke({ query: "anything", session_id: "definitely-not-a-session" })
    expect(String(output)).toContain('error: unknown session "definitely-not-a-session"')
  })
})

describe("recall context windows", () => {
  const { Store } = require("../store.ts") as typeof import("../store.ts")
  const { recallWindows, resolveRecallWindow, describeRecallWindows } = require("./recall.ts") as typeof import("./recall.ts")
  const user = (seq: number, text: string) => row(seq, { type: "message.user", text })
  const compacted = (seq: number) => row(seq, { type: "context.compacted", sessionId: "s" })

  test("no compaction yields a single current window spanning the transcript", () => {
    expect(recallWindows([])).toEqual([{ index: 1, seqStart: 0, seqEnd: 0, current: true }])
    const windows = recallWindows([user(0, "a"), row(1, { type: "message.delta", text: "b" }), user(2, "c")])
    expect(windows).toEqual([{ index: 1, seqStart: 0, seqEnd: 2, current: true }])
    expect(resolveRecallWindow(windows, -1)).toBe(windows[0])
    expect(resolveRecallWindow(windows, -2)).toBeUndefined()
    expect(resolveRecallWindow(windows, 0)).toBeUndefined()
  })

  test("one compaction splits the transcript into a closed window and the current one", () => {
    const windows = recallWindows([user(0, "old"), compacted(1), user(2, "new"), user(3, "newer")])
    expect(windows).toEqual([
      { index: 1, seqStart: 0, seqEnd: 1, current: false },
      { index: 2, seqStart: 2, seqEnd: 3, current: true },
    ])
    expect(resolveRecallWindow(windows, -2)).toBe(windows[0])
    expect(resolveRecallWindow(windows, 1)).toBe(windows[0])
    expect(resolveRecallWindow(windows, 2)).toBe(windows[1])
    expect(resolveRecallWindow(windows, 3)).toBeUndefined()
  })

  test("three compactions yield four windows and a readable listing", () => {
    const history = [
      user(0, "first goal"), row(1, { type: "tool.start", id: "a", name: "bash", input: {} }), compacted(2),
      user(3, "second"), compacted(4),
      compacted(5),
      user(6, "current work ".repeat(20)),
    ]
    const windows = recallWindows(history)
    expect(windows.map((w) => [w.seqStart, w.seqEnd, w.current])).toEqual([[0, 2, false], [3, 4, false], [5, 5, false], [6, 6, true]])
    expect(resolveRecallWindow(windows, -1)).toBe(windows[3])
    expect(resolveRecallWindow(windows, -4)).toBe(windows[0])
    expect(resolveRecallWindow(windows, -5)).toBeUndefined()
    const listing = describeRecallWindows(history, [{ turnIndex: 1, startEventSeq: 0 }, { turnIndex: 2, startEventSeq: 3 }, { turnIndex: 3, startEventSeq: 6 }], windows)
    const lines = listing.split("\n")
    expect(lines).toHaveLength(4)
    expect(lines[0]).toBe('window 1: seq 0–2, turn 1, 3 events, 1 tool calls, first user message: "first goal"')
    expect(lines[2]).toBe("window 3: seq 5–5, no turns, 1 events, 0 tool calls, first user message: (none)")
    expect(lines[3]).toStartWith("window 4 (current): seq 6–6, turn 3, 1 events, 0 tool calls, first user message: \"current work")
    expect(lines[3]).toContain("…")
  })

  test("the tool restricts ranges to a window, lists windows, and keeps seqs on each line", async () => {
    const id = `recall-window-${crypto.randomUUID()}`
    Store.createSession(id)
    Store.startTurn(id, "old ask", null)
    Store.appendEvent(id, { type: "message.user", text: "old ask" })
    Store.appendEvent(id, { type: "message.delta", text: "old answer" })
    Store.appendEvent(id, { type: "context.compacted", sessionId: id })
    Store.startTurn(id, "new ask", null)
    Store.appendEvent(id, { type: "message.user", text: "new ask" })
    Store.appendEvent(id, { type: "message.delta", text: "new answer" })
    const cfg = { configurable: { thread_id: id } }

    const previous = String(await recall.invoke({ window: -2 }, cfg))
    expect(previous).toContain("(window 1 of 2, seq 0–2)")
    expect(previous).toContain("[0 user] old ask")
    expect(previous).toContain("[1 assistant] old answer")
    expect(previous).not.toContain("new ask")
    const current = String(await recall.invoke({ window: -1, query: "answer" }, cfg))
    expect(current).toContain("[4 assistant] new answer")
    expect(current).not.toContain("old answer")
    const before = String(await recall.invoke({ query: "ask", before_compaction: true }, cfg))
    expect(before).toContain("[0 user] old ask")
    expect(before).not.toContain("new ask")
    expect(String(await recall.invoke({ window: 5 }, cfg))).toContain("error: window 5 does not exist; this session has 2 window(s)")

    const listing = String(await recall.invoke({ list_windows: true, query: "ignored" }, cfg))
    expect(listing).toContain(`Context windows for session ${id} (2):`)
    expect(listing).toContain('window 1: seq 0–2, turn 1, 3 events, 0 tool calls, first user message: "old ask"')
    expect(listing).toContain('window 2 (current): seq 3–4, turn 2, 2 events, 0 tool calls, first user message: "new ask"')
  })

  test("accepts window or list_windows without a query", () => {
    expect(recall.schema.safeParse({ window: -1 }).success).toBe(true)
    expect(recall.schema.safeParse({ list_windows: true }).success).toBe(true)
    expect(recall.schema.safeParse({ window: 1.5 }).success).toBe(false)
  })
})
