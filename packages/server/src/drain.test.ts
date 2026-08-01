// Retirement policy: a superseded server must finish its in-flight work before
// exiting, must not wait forever, and must abort exactly once.
import { describe, expect, test } from "bun:test"
import { DRAIN_REFUSAL, DrainCoordinator, drainStep } from "./drain.ts"

function clock(start = 1_000) {
  let now = start
  return { now: () => now, advance: (ms: number) => { now += ms } }
}

describe("DrainCoordinator", () => {
  test("is inert until retirement begins", () => {
    const time = clock()
    const drain = new DrainCoordinator(time.now, 5_000)
    expect(drain.draining).toBe(false)
    expect(drain.evaluate(3)).toBe("idle")
    expect(drain.remainingMs()).toBeNull()
    expect(drain.snapshot()).toEqual({ retiring: false, since: null, deadline: null })
  })

  test("begins once and reports its deadline", () => {
    const time = clock()
    const drain = new DrainCoordinator(time.now, 5_000)
    expect(drain.begin()).toBe(true)
    expect(drain.begin()).toBe(false)
    expect(drain.draining).toBe(true)
    expect(drain.snapshot()).toEqual({ retiring: true, since: 1_000, deadline: 6_000 })
    time.advance(2_000)
    expect(drain.remainingMs()).toBe(3_000)
    time.advance(9_000)
    expect(drain.remainingMs()).toBe(0)
  })

  test("an idle server retires immediately", () => {
    const drain = new DrainCoordinator(clock().now, 5_000)
    drain.begin()
    expect(drain.evaluate(0)).toBe("finish")
  })

  test("waits while a run is in flight, then finishes when it completes", () => {
    const time = clock()
    const drain = new DrainCoordinator(time.now, 5_000)
    drain.begin()
    expect(drain.evaluate(1)).toBe("wait")
    time.advance(4_999)
    expect(drain.evaluate(1)).toBe("wait")
    expect(drain.evaluate(0)).toBe("finish")
  })

  test("forces exactly once after the timeout, then stops waiting", () => {
    const time = clock()
    const drain = new DrainCoordinator(time.now, 5_000)
    drain.begin()
    time.advance(5_000)
    expect(drain.evaluate(2)).toBe("force")
    // A run that ignores its abort must not pin the server forever.
    expect(drain.evaluate(2)).toBe("finish")
  })
})

describe("drainStep", () => {
  function harness(timeoutMs = 5_000) {
    const time = clock()
    const drain = new DrainCoordinator(time.now, timeoutMs)
    const state = { running: 0, aborted: 0, finished: 0, logs: [] as string[] }
    const deps = {
      runningCount: () => state.running,
      abortAll: () => {
        state.aborted++
        state.running = 0 // aborting tears the runs down
      },
      finish: () => { state.finished++ },
      log: (message: string) => state.logs.push(message),
    }
    return { drain, time, state, step: () => drainStep(drain, deps) }
  }

  test("an in-flight run completes before the server shuts down", () => {
    const h = harness()
    h.state.running = 1
    h.drain.begin()

    expect(h.step()).toBe(false)
    expect(h.state.finished).toBe(0)
    expect(h.state.aborted).toBe(0)

    h.time.advance(2_000)
    expect(h.step()).toBe(false)
    expect(h.state.aborted).toBe(0)

    // The run finishes on its own.
    h.state.running = 0
    expect(h.step()).toBe(true)
    expect(h.state.finished).toBe(1)
    expect(h.state.aborted).toBe(0)
  })

  test("a run that outlasts the drain timeout is aborted, then the server exits", () => {
    const h = harness(3_000)
    h.state.running = 2
    h.drain.begin()
    expect(h.step()).toBe(false)

    h.time.advance(3_000)
    expect(h.step()).toBe(false)
    expect(h.state.aborted).toBe(1)
    expect(h.state.logs[0]).toContain("drain timeout reached")
    expect(h.state.finished).toBe(0)

    expect(h.step()).toBe(true)
    expect(h.state.finished).toBe(1)
    expect(h.state.aborted).toBe(1)
  })

  test("stops without shutting anything down when not retiring", () => {
    const h = harness()
    h.state.running = 1
    expect(h.step()).toBe(true)
    expect(h.state.finished).toBe(0)
  })
})

describe("refusal message", () => {
  test("tells the client to reconnect rather than blaming the request", () => {
    expect(DRAIN_REFUSAL).toContain("Reconnect")
  })
})
