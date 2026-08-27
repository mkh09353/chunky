import { describe, expect, test } from "bun:test"
import type { AgentEvent } from "@chunky/protocol"
import { createMessageCoalescer, MESSAGE_FLUSH_BYTES } from "./message-coalescer.ts"

function events(input: AgentEvent[]): AgentEvent[] { const out: AgentEvent[] = []; const add = createMessageCoalescer((_session, ev) => out.push(ev)); for (const ev of input) add("s", ev); return out }

describe("message delta persistence coalescing", () => {
  test("reports each canonical event with the persistence result", () => {
    const reported: Array<{ event: AgentEvent; seq: number }> = []
    let seq = 0
    const add = createMessageCoalescer(
      (_session, _event) => seq++,
      (_session, event, persistedSeq) => reported.push({ event, seq: persistedSeq }),
    )
    add("s", { type: "message.start", role: "assistant" })
    add("s", { type: "message.delta", text: "canonical" })
    add("s", { type: "message.end" })
    expect(reported).toEqual([
      { event: { type: "message.start", role: "assistant" }, seq: 0 },
      { event: { type: "message.delta", text: "canonical" }, seq: 1 },
      { event: { type: "message.end" }, seq: 2 },
    ])
  })

  test("finished messages persist one coalesced delta and end", () => {
    const out = events([{ type: "message.start", role: "assistant" }, { type: "message.delta", text: "a" }, { type: "message.delta", text: "b" }, { type: "message.end" }])
    expect(out).toEqual([{ type: "message.start", role: "assistant" }, { type: "message.delta", text: "ab" }, { type: "message.end" }])
  })
  test("old and coalesced shapes reconstruct identically", () => {
    const old = [{ type: "message.start", role: "assistant" }, ..."abc".split("").map((text) => ({ type: "message.delta", text })), { type: "message.end" }]
    const newer = [{ type: "message.start", role: "assistant" }, { type: "message.delta", text: "abc" }, { type: "message.end" }]
    expect(old.filter((e) => e.type === "message.delta").map((e: any) => e.text).join("")).toBe((newer[1] as any).text)
  })
  test("flushes periodically at 8KB", () => {
    const out = events([{ type: "message.start", role: "assistant" }, { type: "message.delta", text: "x".repeat(MESSAGE_FLUSH_BYTES) }])
    expect(out).toHaveLength(2); expect((out[1] as any).text).toHaveLength(MESSAGE_FLUSH_BYTES)
  })
  test("flushes before interleaved non-delta events", () => {
    const out = events([{ type: "message.start", role: "assistant" }, { type: "message.delta", text: "pending" }, { type: "tool.start", id: "t", name: "x", input: {} } as any])
    expect(out.map((e) => e.type)).toEqual(["message.start", "message.delta", "tool.start"])
  })
  test("cutoff retains periodically flushed text", () => {
    const text = "x".repeat(MESSAGE_FLUSH_BYTES)
    const out = events([{ type: "message.start", role: "assistant" }, { type: "message.delta", text }, { type: "message.delta", text: "tail" }])
    expect((out.find((e) => e.type === "message.delta") as any).text).toBe(text)
  })
})
