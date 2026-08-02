import { expect, test } from "bun:test"
import {
  autoTitleInFlight,
  autoTitleSession,
  normalizeAutoTitle,
  setAutoTitleInvokerForTests,
} from "./auto-title.ts"
import { Store } from "./store.ts"

function session(name = "auto-title") {
  const id = `${name}-${crypto.randomUUID()}`
  Store.createSession(id)
  Store.appendEvent(id, { type: "message.user", text: "Improve the session title handling" })
  Store.appendEvent(id, { type: "message.delta", text: "I updated the title handling and tests." })
  return id
}

const emit = (events: unknown[]) => (ev: unknown) => events.push(ev)

test("normalizes generated titles", () => {
  expect(normalizeAutoTitle('"Fix\nterminal titles!"')).toBe("Fix terminal titles")
  expect(normalizeAutoTitle("a ".repeat(40))).toHaveLength(60)
})

test("skips custom and missing sessions", async () => {
  const custom = session("custom")
  Store.setTitle(custom, "User chosen")
  let calls = 0
  setAutoTitleInvokerForTests(async () => { calls++; return "Should not run" })
  try {
    await autoTitleSession(custom, 1, () => {})
    await autoTitleSession(`missing-${crypto.randomUUID()}`, 1, () => {})
    expect(calls).toBe(0)
  } finally {
    setAutoTitleInvokerForTests(null)
  }
})

test("generates once for concurrent requests and emits the title event", async () => {
  const id = session()
  const events: unknown[] = []
  let calls = 0
  setAutoTitleInvokerForTests(async () => {
    calls++
    await Bun.sleep(15)
    return { content: '"Improve\nsession titles"' }
  })
  try {
    const first = autoTitleSession(id, 1, emit(events))
    const second = autoTitleSession(id, 2, emit(events))
    expect(autoTitleInFlight(id)).toBe(true)
    await Promise.all([first, second])
    expect(calls).toBe(1)
    expect(events).toEqual([{ type: "session.title", sessionId: id, title: "Improve session titles" }])
    expect(Store.titleOf(id)).toBe("Improve session titles")
  } finally {
    setAutoTitleInvokerForTests(null)
  }
})

test("silently ignores model failures", async () => {
  const id = session("failure")
  const events: unknown[] = []
  setAutoTitleInvokerForTests(async () => { throw new Error("provider unavailable") })
  try {
    await expect(autoTitleSession(id, 1, emit(events))).resolves.toBeUndefined()
    expect(events).toEqual([])
    expect(Store.titleOf(id)).toBe("New session")
  } finally {
    setAutoTitleInvokerForTests(null)
  }
})
