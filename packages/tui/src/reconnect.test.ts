import { describe, expect, test } from "bun:test"
import { abortableSleep, isIntentionalAbort, reconnectDelay, retryableHttpMessage } from "./reconnect.js"
import { replayHistory } from "./transcript.js"

describe("SSE reconnect policy", () => {
  test("uses bounded exponential backoff", () => {
    expect(reconnectDelay(0)).toBe(500)
    expect(reconnectDelay(1)).toBe(1000)
    expect(reconnectDelay(10)).toBe(30_000)
  })

  test("does not surface intentional cleanup aborts", () => {
    const controller = new AbortController()
    controller.abort()
    expect(isIntentionalAbort(new DOMException("aborted", "AbortError"), controller.signal, false)).toBe(true)
    expect(isIntentionalAbort(new Error("socket closed"), new AbortController().signal, true)).toBe(true)
  })

  test("classifies HTTP failures without transport internals", () => {
    expect(retryableHttpMessage(503)).toBe("Reconnecting… (server unavailable: HTTP 503)")
  })

  test("abortable sleep resolves promptly", async () => {
    const controller = new AbortController()
    const started = Date.now()
    const sleeping = abortableSleep(30_000, controller.signal)
    controller.abort()
    await sleeping
    expect(Date.now() - started).toBeLessThan(1000)
  })

  test("full replay reconstructs terminal root, thread, and tool state", () => {
    const events = [
      { type: "session.status", sessionId: "s", status: "running" },
      { type: "thread.spawn", threadId: "child", parentThreadId: null, title: "Sidekick" },
      { type: "tool.start", id: "tool", name: "bash", input: {} },
      { type: "tool.end", id: "tool", ok: true, output: "done" },
      { type: "thread.status", threadId: "child", status: "idle" },
      { type: "session.status", sessionId: "s", status: "idle" },
    ] as const
    const state = replayHistory([...events])
    expect(state.status).toBe("idle")
    expect(state.threads.child?.status).toBe("idle")
    expect(state.threads.main?.items.filter((item) => item.kind === "tool")).toHaveLength(1)
  })
})
