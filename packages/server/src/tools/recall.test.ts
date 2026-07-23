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
