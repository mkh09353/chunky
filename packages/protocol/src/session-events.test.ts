import { describe, expect, test } from "bun:test"
import {
  decodeSessionEventCursor,
  encodeSessionEventCursor,
  readSessionEventStream,
  sessionEventsUrl,
  sseFrame,
  type SessionEventCursor,
  type SessionEventStreamFrame,
} from "./index.ts"

const cursor: SessionEventCursor = { generation: "generation-α", nextSeq: 7 }

async function collect(body: ReadableStream<Uint8Array> | string) {
  const response = typeof body === "string" ? new Response(body) : new Response(body)
  return await Array.fromAsync(readSessionEventStream(response))
}

describe("session event cursors", () => {
  test("round-trips as base64url", () => {
    const encoded = encodeSessionEventCursor(cursor)
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(decodeSessionEventCursor(encoded)).toEqual(cursor)
    expect(sessionEventsUrl("s/1", { cursor: encoded })).toBe(`/api/sessions/s/1/events?stream=v2&cursor=${encodeURIComponent(encoded)}`)
    expect(sessionEventsUrl("s")).toBe("/api/sessions/s/events?stream=v2")
  })

  test("rejects malformed, negative, fractional, and unsupported cursors", () => {
    const raw = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")
    for (const value of ["", "!", raw({ v: 2, g: "g", n: 1 }), raw({ v: 1, g: "", n: 1 }), raw({ v: 1, g: "g", n: -1 }), raw({ v: 1, g: "g", n: 1.5 }), raw({ v: 1, g: "g", n: "1" }), raw(null)]) {
      expect(decodeSessionEventCursor(value)).toBeNull()
    }
  })
})

describe("session event SSE frames", () => {
  test("round-trips every v2 frame", async () => {
    const frames: SessionEventStreamFrame[] = [
      { kind: "event", seq: 6, cursor, event: { type: "message.user", text: "hello" } },
      { kind: "live", event: { type: "tool.progress", id: "t", chunk: "working" } },
      { kind: "replay-end", cursor },
      { kind: "replay-reset", reason: "history-rewritten", cursor: { generation: "new", nextSeq: 0 } },
    ]
    expect(await collect(frames.map(sseFrame).join(""))).toEqual(frames)
  })

  test("parses split chunks, comments, multiline data, and legacy frames", async () => {
    const encoded = encodeSessionEventCursor(cursor)
    const wire = [
      ": ready\n\n",
      `event: session.event\nid: ${encoded}\ndata: {"seq":6,\ndata: "event":{"type":"message.user","text":"split"}}\n\n`,
      `data: ${JSON.stringify({ type: "message.delta", text: "legacy" })}\n\n`,
      ": ping\n\n",
    ].join("")
    const bytes = new TextEncoder().encode(wire)
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3))
        controller.close()
      },
    })
    expect(await collect(stream)).toEqual([
      { kind: "event", seq: 6, cursor, event: { type: "message.user", text: "split" } },
      { kind: "legacy", event: { type: "message.delta", text: "legacy" } },
    ])
  })
})
