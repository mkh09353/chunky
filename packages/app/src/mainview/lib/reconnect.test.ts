import { describe, expect, test } from "bun:test"
import type { AgentEvent } from "@chunky/protocol"
import { isIntentionalAbort, reconnectDelay } from "./reconnect"
import { sleep } from "./sleep"
import { initialState, reduce, type TranscriptState } from "./transcript"

/** Rebuild a projection from a server history replay, the way attachSession does
 *  (reset to initialState, then feed the replayed events). */
function replay(events: AgentEvent[]): TranscriptState {
  return events.reduce(reduce, initialState)
}

describe("SSE reconnect policy", () => {
  // Must stay identical to packages/tui/src/reconnect.ts — the two clients are
  // expected to back off the same way against the same server.
  test("uses bounded exponential backoff", () => {
    expect(reconnectDelay(0)).toBe(500)
    expect(reconnectDelay(1)).toBe(1000)
    expect(reconnectDelay(10)).toBe(30_000)
  })

  test("does not surface intentional cleanup aborts", () => {
    const controller = new AbortController()
    controller.abort()
    expect(isIntentionalAbort(new DOMException("aborted", "AbortError"), controller.signal)).toBe(true)
    expect(isIntentionalAbort(new Error("socket closed"), new AbortController().signal, true)).toBe(true)
    // A genuine mid-stream drop must NOT read as intentional, or the loop breaks
    // and the client silently detaches.
    expect(isIntentionalAbort(new Error("socket closed"), new AbortController().signal)).toBe(false)
  })

  test("abortable sleep resolves promptly", async () => {
    const controller = new AbortController()
    const started = Date.now()
    const sleeping = sleep(30_000, controller.signal)
    controller.abort()
    await sleeping
    expect(Date.now() - started).toBeLessThan(1000)
  })

  test("re-replaying history from initialState does not duplicate rows", () => {
    // /events has no resume cursor: every reattach replays the FULL history. The
    // reconnect loop resets to initialState before consuming a replay, so the
    // same history applied twice must land on the same projection.
    const events: AgentEvent[] = [
      { type: "session.status", sessionId: "s", status: "running" },
      { type: "message.user", text: "hi" },
      { type: "message.start", role: "assistant" },
      { type: "message.delta", text: "hello" },
      { type: "message.end", reason: "complete" },
      { type: "session.status", sessionId: "s", status: "idle" },
    ]
    const once = replay(events)
    const twice = replay(events)
    expect(twice.threads.main?.items).toEqual(once.threads.main?.items ?? [])
    expect(once.threads.main?.items.filter((i) => i.kind === "user")).toHaveLength(1)
    expect(twice.status).toBe("idle")
  })
})

describe("prompt queue projection", () => {
  test("queue.changed is a last-wins server snapshot", () => {
    const entry = {
      id: "q-1",
      version: 1,
      text: "model prompt",
      shown: "visible prompt",
      kind: "prompt" as const,
      position: 0,
      createdAt: 1,
    }
    const state = replay([
      { type: "queue.changed", sessionId: "s", entries: [entry], running: true },
      { type: "queue.changed", sessionId: "s", entries: [], running: false },
    ])
    // The later snapshot wins outright — entries are never merged or appended.
    expect(state.queue).toEqual({ entries: [], running: false })

    const queued = replay([{ type: "queue.changed", sessionId: "s", entries: [entry], running: true }])
    expect(queued.queue.entries).toEqual([entry])
    expect(queued.queue.running).toBe(true)
    // A queue snapshot alone must not fabricate transcript rows.
    expect(queued.threads.main?.items).toHaveLength(0)
  })

  test("initialState carries an empty queue so a thread switch resets it", () => {
    expect(initialState.queue).toEqual({ entries: [], running: false })
  })

  test("a queued prompt renders exactly once, on drain", () => {
    // The real server sequence for a send during a running turn: enqueue emits
    // only queue.changed (no message.user), then on drain it clears the queue and
    // emits message.user with the entry's `shown` text. The prompt must not show
    // as a transcript row while queued, and must not double once drained.
    const entry = {
      id: "q-1",
      version: 1,
      text: "model prompt",
      shown: "do the thing",
      kind: "prompt" as const,
      position: 0,
      createdAt: 1,
    }
    const queued = replay([
      { type: "session.status", sessionId: "s", status: "running" },
      { type: "queue.changed", sessionId: "s", entries: [entry], running: true },
    ])
    expect(queued.queue.entries).toHaveLength(1)
    expect(queued.threads.main?.items).toHaveLength(0)

    const drained = replay([
      { type: "session.status", sessionId: "s", status: "running" },
      { type: "queue.changed", sessionId: "s", entries: [entry], running: true },
      { type: "session.status", sessionId: "s", status: "idle" },
      { type: "queue.changed", sessionId: "s", entries: [], running: false },
      { type: "message.user", text: "do the thing" },
    ])
    expect(drained.queue.entries).toHaveLength(0)
    expect(drained.threads.main?.items).toEqual([{ kind: "user", text: "do the thing" }])
  })
})

describe("interjections", () => {
  test("renders acceptance once and ignores the injection marker", () => {
    // The server emits BOTH for the same text: injected:false on acceptance,
    // injected:true when the run feeds it to the model. Rendering both doubles it.
    const state = replay([
      { type: "message.interjection", sessionId: "s", text: "change course", injected: false },
      { type: "message.interjection", sessionId: "s", text: "change course", injected: true },
    ])
    const items = state.threads.main?.items ?? []
    expect(items).toHaveLength(1)
    expect(items[0]).toEqual({ kind: "user", text: "change course", interjection: true })
  })

  test("an injected-only marker renders nothing", () => {
    const state = replay([
      { type: "message.interjection", sessionId: "s", text: "change course", injected: true },
    ])
    expect(state.threads.main?.items ?? []).toHaveLength(0)
  })

  test("interjections and ordinary user turns coexist without dedup crosstalk", () => {
    const state = replay([
      { type: "message.user", text: "first" },
      { type: "message.interjection", sessionId: "s", text: "actually, wait", injected: false },
      { type: "message.interjection", sessionId: "s", text: "actually, wait", injected: true },
    ])
    const items = state.threads.main?.items ?? []
    expect(items).toEqual([
      { kind: "user", text: "first" },
      { kind: "user", text: "actually, wait", interjection: true },
    ])
  })
})
