import { expect, test } from "bun:test"
import type { SessionSummary } from "@chunky/protocol"
import { activeIncognito } from "./incognito"

const session = (sessionId: string, incognito?: boolean): SessionSummary => ({
  sessionId,
  title: sessionId,
  createdAt: 1,
  lastActivity: 2,
  workspace: "/tmp/repo",
  ...(incognito === undefined ? {} : { incognito }),
})

test("no attached thread is never incognito", () => {
  expect(activeIncognito([session("a", true)], null, null)).toBe(false)
})

test("the attached thread's own flag decides it", () => {
  const sessions = [session("a", true), session("b", false)]
  expect(activeIncognito(sessions, "a", null)).toBe(true)
  expect(activeIncognito(sessions, "b", null)).toBe(false)
})

test("a server that omits the field reads as a normal thread", () => {
  expect(activeIncognito([session("a")], "a", null)).toBe(false)
})

test("a just-created thread is seeded from the create response", () => {
  expect(activeIncognito([], "new", { sessionId: "new", incognito: true })).toBe(true)
  expect(activeIncognito([], "new", { sessionId: "new", incognito: false })).toBe(false)
})

test("the seed is dropped once we attach to a different thread", () => {
  expect(activeIncognito([], "other", { sessionId: "new", incognito: true })).toBe(false)
  expect(activeIncognito([session("other", false)], "other", { sessionId: "new", incognito: true })).toBe(false)
})

test("the list wins over a stale seed for the same id", () => {
  expect(activeIncognito([session("a", false)], "a", { sessionId: "a", incognito: true })).toBe(false)
})
