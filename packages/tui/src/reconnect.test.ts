import { describe, expect, test } from "bun:test"
import { abortableSleep, isIntentionalAbort, reconnectDelay, retryableHttpMessage, isConnectionRefused, RERESOLVE_AFTER_ATTEMPTS, RERESOLVE_AFTER_REFUSED_ATTEMPTS, shouldReresolve } from "./reconnect.js"
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

describe("re-resolution policy", () => {
  test("a retiring server moves us immediately", () => {
    expect(shouldReresolve({ attempts: 0, retiring: true })).toBe(true)
  })

  test("transient drops keep retrying the same server", () => {
    expect(shouldReresolve({ attempts: 1 })).toBe(false)
    expect(shouldReresolve({ attempts: 2 })).toBe(false)
    expect(shouldReresolve({ attempts: 1, error: new Error("Reconnecting… (server unavailable: HTTP 502)") })).toBe(false)
  })

  test("enough consecutive failures, or a refused connection, look elsewhere", () => {
    expect(shouldReresolve({ attempts: RERESOLVE_AFTER_ATTEMPTS })).toBe(true)
    const refused = Object.assign(new Error("Unable to connect. Is the computer able to access the url?"), { code: "ConnectionRefused" })
    expect(shouldReresolve({ attempts: RERESOLVE_AFTER_REFUSED_ATTEMPTS, error: refused })).toBe(true)
    expect(shouldReresolve({ attempts: RERESOLVE_AFTER_REFUSED_ATTEMPTS - 1, error: refused })).toBe(false)
  })

  test("recognises refusal wordings without mistaking HTTP failures for them", () => {
    expect(isConnectionRefused(new Error("connect ECONNREFUSED 127.0.0.1:4620"))).toBe(true)
    expect(isConnectionRefused(new Error("Reconnecting… (server unavailable: HTTP 503)"))).toBe(false)
  })
})
