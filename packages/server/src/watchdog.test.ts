// Deterministic watchdog tests: tiny real timeouts, no model or credentials.
import { test, expect } from "bun:test"
import { createDelegateWatchdog, delegateIdleTimeoutMs } from "./watchdog.ts"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

test("fires after idle timeout and aborts the combined controller", async () => {
  const dog = createDelegateWatchdog({ emit: () => {}, label: "sidekick", timeoutMs: 20 })
  expect(dog.timedOut()).toBe(false)
  await sleep(40)
  expect(dog.timedOut()).toBe(true)
  expect(dog.abort.signal.aborted).toBe(true)
  expect(dog.timeoutMessage()).toContain("inactivity watchdog")
  dog.dispose()
})

test("stream activity resets the timer", async () => {
  const events: string[] = []
  const dog = createDelegateWatchdog({ emit: (e) => events.push(e.type), label: "advisor", timeoutMs: 50 })
  for (let i = 0; i < 4; i++) {
    await sleep(25)
    dog.emit({ type: "message.delta", text: "tick" } as any)
  }
  // 100ms elapsed > timeout, but activity every 25ms kept it alive.
  expect(dog.timedOut()).toBe(false)
  expect(events).toEqual(["message.delta", "message.delta", "message.delta", "message.delta"])
  dog.dispose()
  await sleep(70)
  expect(dog.timedOut()).toBe(false) // disposed — never fires
})

test("parent (user interrupt) abort propagates without marking timedOut", async () => {
  const parent = new AbortController()
  const dog = createDelegateWatchdog({ emit: () => {}, label: "child thread", parent, timeoutMs: 10_000 })
  parent.abort(new Error("user interrupt"))
  expect(dog.abort.signal.aborted).toBe(true)
  expect(dog.timedOut()).toBe(false)
  dog.dispose()
})

test("timeoutMs 0 disables the watchdog", async () => {
  const dog = createDelegateWatchdog({ emit: () => {}, label: "sidekick", timeoutMs: 0 })
  await sleep(30)
  expect(dog.timedOut()).toBe(false)
  expect(dog.abort.signal.aborted).toBe(false)
  dog.dispose()
})

test("CHUNKY_DELEGATE_IDLE_MINUTES overrides the default window", () => {
  const prev = process.env.CHUNKY_DELEGATE_IDLE_MINUTES
  try {
    process.env.CHUNKY_DELEGATE_IDLE_MINUTES = "5"
    expect(delegateIdleTimeoutMs()).toBe(5 * 60_000)
    process.env.CHUNKY_DELEGATE_IDLE_MINUTES = "0"
    expect(delegateIdleTimeoutMs()).toBe(0)
    delete process.env.CHUNKY_DELEGATE_IDLE_MINUTES
    expect(delegateIdleTimeoutMs()).toBe(15 * 60_000)
  } finally {
    if (prev === undefined) delete process.env.CHUNKY_DELEGATE_IDLE_MINUTES
    else process.env.CHUNKY_DELEGATE_IDLE_MINUTES = prev
  }
})
