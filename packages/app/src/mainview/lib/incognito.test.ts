import { expect, test } from "bun:test"
import type { SessionSummary } from "@chunky/protocol"
import {
  activeIncognito,
  incognitoAppliedLine,
  isIncognitoMode,
  NO_INCOGNITO_MODES,
  notIncognitoLine,
  resolveIncognitoCommand,
  unknownModeLine,
  type SavedMode,
} from "./incognito"

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

// ---- /incognito command resolution ----

const savedMode = (name: string, allow?: string[]): SavedMode =>
  ({ name, provider: "zai", model: "glm-5.2", ...(allow ? { incognito: { allow } } : {}) }) as SavedMode

test("an incognito mode is one whose spec carries the allowlist", () => {
  expect(isIncognitoMode(savedMode("ghost", ["local"]))).toBe(true)
  expect(isIncognitoMode(savedMode("fire"))).toBe(false)
})

test("no incognito modes saved -> explain how to make one", () => {
  expect(resolveIncognitoCommand([savedMode("fire")], "")).toEqual({ kind: "none" })
  expect(NO_INCOGNITO_MODES).toContain("allow")
  expect(NO_INCOGNITO_MODES).toContain("scope")
})

test("exactly one incognito mode -> apply it; several -> pick from just those", () => {
  expect(resolveIncognitoCommand([savedMode("fire"), savedMode("ghost", ["local"])], "")).toEqual({
    kind: "apply",
    name: "ghost",
  })
  const many = resolveIncognitoCommand(
    [savedMode("fire"), savedMode("ghost", ["local"]), savedMode("vault", ["local"])],
    "",
  )
  expect(many.kind).toBe("pick")
  expect(many.kind === "pick" && many.modes.map((m) => m.name)).toEqual(["ghost", "vault"])
})

test("a named mode applies only when it's incognito, case-insensitively", () => {
  const modes = [savedMode("fire"), savedMode("Ghost", ["local"])]
  expect(resolveIncognitoCommand(modes, "ghost")).toEqual({ kind: "apply", name: "Ghost" })
  expect(resolveIncognitoCommand(modes, "fire")).toEqual({ kind: "not-incognito", name: "fire" })
  expect(resolveIncognitoCommand(modes, "nope")).toEqual({ kind: "unknown", name: "nope" })
})

test("the applied line says it takes effect for NEW threads", () => {
  const line = incognitoAppliedLine("ghost", "GLM 5.2 · zai")
  expect(line).toContain('"ghost"')
  expect(line).toContain("NEW threads")
  expect(line).toContain("New thread")
})

test("the refusals name the mode and point somewhere useful", () => {
  expect(notIncognitoLine("fire")).toContain("/mode fire")
  expect(unknownModeLine("nope")).toContain('"nope"')
})
