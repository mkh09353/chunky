// Deterministic watchdog tests: tiny real timeouts, no model or credentials.
import { test, expect } from "bun:test"
import {
  createDelegateWatchdog,
  delegateIdleTimeoutMs,
  delegateStallTimeoutMs,
  delegateWatchdogWindows,
} from "./watchdog.ts"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const prev: Record<string, string | undefined> = {}
  for (const key of Object.keys(vars)) prev[key] = process.env[key]
  try {
    for (const [key, value] of Object.entries(vars)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    fn()
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

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

test("short-window fire while awaiting model output", async () => {
  const dog = createDelegateWatchdog({
    emit: () => {},
    label: "sidekick",
    timeoutMs: 200,
    stallMs: 20,
  })
  await sleep(45)
  expect(dog.timedOut()).toBe(true)
  expect(dog.abort.signal.aborted).toBe(true)
  expect(dog.timeoutMessage()).toContain("while waiting for model output")
  expect(dog.timeoutMessage()).toContain("CHUNKY_DELEGATE_STALL_MINUTES")
  dog.dispose()
})

test("no short-window fire while a tool is pending", async () => {
  const dog = createDelegateWatchdog({
    emit: () => {},
    label: "sidekick",
    timeoutMs: 80,
    stallMs: 20,
  })
  dog.emit({ type: "tool.start", id: "t1", name: "bash", input: {} } as any)
  await sleep(45)
  expect(dog.timedOut()).toBe(false)
  expect(dog.abort.signal.aborted).toBe(false)
  dog.dispose()
})

test("window switches back to the stream window after tool.end", async () => {
  const dog = createDelegateWatchdog({
    emit: () => {},
    label: "advisor",
    timeoutMs: 120,
    stallMs: 25,
  })
  dog.emit({ type: "tool.start", id: "t1", name: "bash", input: {} } as any)
  await sleep(50)
  expect(dog.timedOut()).toBe(false)
  dog.emit({ type: "tool.end", id: "t1", ok: true, output: "ok" } as any)
  await sleep(50)
  expect(dog.timedOut()).toBe(true)
  expect(dog.timeoutMessage()).toContain("while waiting for model output")
  expect(dog.timeoutMessage()).not.toContain("during a tool call")
  dog.dispose()
})

test("tool window fires during a pending tool call", async () => {
  const dog = createDelegateWatchdog({
    emit: () => {},
    label: "sidekick",
    timeoutMs: 25,
    stallMs: 10,
  })
  dog.emit({ type: "tool.start", id: "t1", name: "bash", input: {} } as any)
  await sleep(45)
  expect(dog.timedOut()).toBe(true)
  expect(dog.timeoutMessage()).toContain("during a tool call")
  expect(dog.timeoutMessage()).toContain("CHUNKY_DELEGATE_IDLE_MINUTES")
  expect(dog.timeoutMessage()).not.toContain("while waiting for model output")
  dog.dispose()
})

test("tool.progress is activity and does not leave the tool window", async () => {
  const dog = createDelegateWatchdog({
    emit: () => {},
    label: "child thread",
    timeoutMs: 80,
    stallMs: 20,
  })
  dog.emit({ type: "tool.start", id: "t1", name: "bash", input: {} } as any)
  await sleep(15)
  dog.emit({ type: "tool.progress", id: "t1", chunk: "." } as any)
  await sleep(15)
  dog.emit({ type: "tool.progress", id: "t1", chunk: "." } as any)
  await sleep(15)
  expect(dog.timedOut()).toBe(false)
  dog.dispose()
})

test("unbalanced tool.end clamps pending count to 0 (stream window)", async () => {
  const dog = createDelegateWatchdog({
    emit: () => {},
    label: "review",
    timeoutMs: 80,
    stallMs: 20,
  })
  dog.emit({ type: "tool.end", id: "ghost", ok: true, output: "" } as any)
  await sleep(40)
  expect(dog.timedOut()).toBe(true)
  expect(dog.timeoutMessage()).toContain("while waiting for model output")
  dog.dispose()
})

test("nested tools stay on the long window until the last tool.end", async () => {
  const dog = createDelegateWatchdog({
    emit: () => {},
    label: "sidekick",
    timeoutMs: 90,
    stallMs: 20,
  })
  dog.emit({ type: "tool.start", id: "a", name: "bash", input: {} } as any)
  dog.emit({ type: "tool.start", id: "b", name: "read", input: {} } as any)
  dog.emit({ type: "tool.end", id: "b", ok: true, output: "ok" } as any)
  await sleep(40)
  expect(dog.timedOut()).toBe(false)
  dog.emit({ type: "tool.end", id: "a", ok: true, output: "ok" } as any)
  await sleep(40)
  expect(dog.timedOut()).toBe(true)
  expect(dog.timeoutMessage()).toContain("while waiting for model output")
  dog.dispose()
})

test("stallMs 0 disables just the short window and falls back to the tool window", async () => {
  const dog = createDelegateWatchdog({
    emit: () => {},
    label: "sidekick",
    timeoutMs: 50,
    stallMs: 0,
  })
  await sleep(25)
  expect(dog.timedOut()).toBe(false)
  await sleep(40)
  expect(dog.timedOut()).toBe(true)
  expect(dog.timeoutMessage()).toContain("while waiting for model output")
  expect(dog.timeoutMessage()).toContain("CHUNKY_DELEGATE_IDLE_MINUTES")
  dog.dispose()
})

test("env overrides include 0-disable semantics and stall>idle clamping", () => {
  withEnv({ CHUNKY_DELEGATE_IDLE_MINUTES: undefined, CHUNKY_DELEGATE_STALL_MINUTES: undefined }, () => {
    expect(delegateStallTimeoutMs()).toBe(4 * 60_000)
    expect(delegateWatchdogWindows()).toEqual({ toolMs: 15 * 60_000, streamMs: 4 * 60_000 })
  })

  withEnv({ CHUNKY_DELEGATE_IDLE_MINUTES: "5", CHUNKY_DELEGATE_STALL_MINUTES: "2" }, () => {
    expect(delegateIdleTimeoutMs()).toBe(5 * 60_000)
    expect(delegateStallTimeoutMs()).toBe(2 * 60_000)
    expect(delegateWatchdogWindows()).toEqual({ toolMs: 5 * 60_000, streamMs: 2 * 60_000 })
  })

  withEnv({ CHUNKY_DELEGATE_IDLE_MINUTES: undefined, CHUNKY_DELEGATE_STALL_MINUTES: "0" }, () => {
    expect(delegateStallTimeoutMs()).toBe(0)
    expect(delegateWatchdogWindows()).toEqual({ toolMs: 15 * 60_000, streamMs: 15 * 60_000 })
  })

  withEnv({ CHUNKY_DELEGATE_IDLE_MINUTES: "3", CHUNKY_DELEGATE_STALL_MINUTES: "10" }, () => {
    expect(delegateStallTimeoutMs()).toBe(10 * 60_000)
    expect(delegateWatchdogWindows()).toEqual({ toolMs: 3 * 60_000, streamMs: 3 * 60_000 })
  })

  withEnv({ CHUNKY_DELEGATE_IDLE_MINUTES: "0", CHUNKY_DELEGATE_STALL_MINUTES: "2" }, () => {
    expect(delegateIdleTimeoutMs()).toBe(0)
    expect(delegateWatchdogWindows()).toEqual({ toolMs: 0, streamMs: 0 })
  })
})

test("IDLE=0 disables the watchdog even when a stall window is configured", async () => {
  await new Promise<void>((resolve, reject) => {
    withEnv({ CHUNKY_DELEGATE_IDLE_MINUTES: "0", CHUNKY_DELEGATE_STALL_MINUTES: "1" }, () => {
      const dog = createDelegateWatchdog({ emit: () => {}, label: "sidekick" })
      sleep(30)
        .then(() => {
          expect(dog.timedOut()).toBe(false)
          expect(dog.abort.signal.aborted).toBe(false)
          dog.dispose()
          resolve()
        })
        .catch(reject)
    })
  })
})

test("STALL=0 via env uses the tool window for stream silence", async () => {
  await new Promise<void>((resolve, reject) => {
    withEnv({ CHUNKY_DELEGATE_IDLE_MINUTES: undefined, CHUNKY_DELEGATE_STALL_MINUTES: "0" }, () => {
      const dog = createDelegateWatchdog({ emit: () => {}, label: "sidekick", timeoutMs: 40 })
      sleep(20)
        .then(async () => {
          expect(dog.timedOut()).toBe(false)
          await sleep(40)
          expect(dog.timedOut()).toBe(true)
          expect(dog.timeoutMessage()).toContain("CHUNKY_DELEGATE_IDLE_MINUTES")
          dog.dispose()
          resolve()
        })
        .catch(reject)
    })
  })
})
