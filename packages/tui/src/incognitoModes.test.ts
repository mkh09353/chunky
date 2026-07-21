import { expect, test } from "bun:test"
import type { ModeInfo } from "@chunky/protocol"
import {
  isIncognitoMode,
  NO_INCOGNITO_MODES,
  incognitoAppliedLine,
  notIncognitoLine,
  resolveIncognitoCommand,
  unknownModeLine,
  type SavedMode,
} from "./incognitoModes.js"

const mode = (name: string, allow?: string[]): SavedMode =>
  ({ name, provider: "zai", model: "glm-5.2", ...(allow ? { incognito: { allow } } : {}) }) as ModeInfo & SavedMode

test("an incognito mode is one whose spec carries the allowlist", () => {
  expect(isIncognitoMode(mode("ghost", ["local"]))).toBe(true)
  expect(isIncognitoMode(mode("fire"))).toBe(false)
})

test("no incognito modes saved -> explain how to make one", () => {
  expect(resolveIncognitoCommand([mode("fire"), mode("deep")], "")).toEqual({ kind: "none" })
  expect(resolveIncognitoCommand([], "")).toEqual({ kind: "none" })
  // The help has to name the field AND the provider scope, or it isn't help.
  expect(NO_INCOGNITO_MODES).toContain("incognito")
  expect(NO_INCOGNITO_MODES).toContain("allow")
  expect(NO_INCOGNITO_MODES).toContain("scope")
})

test("exactly one incognito mode -> apply it, no picker", () => {
  const action = resolveIncognitoCommand([mode("fire"), mode("ghost", ["local"])], "")
  expect(action).toEqual({ kind: "apply", name: "ghost" })
})

test("several incognito modes -> pick from just those", () => {
  const action = resolveIncognitoCommand(
    [mode("fire"), mode("ghost", ["local"]), mode("vault", ["local", "lan"])],
    "",
  )
  expect(action.kind).toBe("pick")
  expect(action.kind === "pick" && action.modes.map((m) => m.name)).toEqual(["ghost", "vault"])
})

test("a named incognito mode applies, case-insensitively, under its canonical name", () => {
  const modes = [mode("fire"), mode("Ghost", ["local"])]
  expect(resolveIncognitoCommand(modes, "ghost")).toEqual({ kind: "apply", name: "Ghost" })
  expect(resolveIncognitoCommand(modes, "  Ghost  ")).toEqual({ kind: "apply", name: "Ghost" })
})

test("a named NON-incognito mode is refused, not silently applied", () => {
  const action = resolveIncognitoCommand([mode("fire"), mode("ghost", ["local"])], "fire")
  expect(action).toEqual({ kind: "not-incognito", name: "fire" })
  expect(notIncognitoLine("fire")).toContain('"fire"')
  expect(notIncognitoLine("fire")).toContain("/mode fire")
})

test("an unknown name says so rather than picking something else", () => {
  expect(resolveIncognitoCommand([mode("ghost", ["local"])], "nope")).toEqual({ kind: "unknown", name: "nope" })
  expect(unknownModeLine("nope")).toContain('"nope"')
})

test("a name always wins over the count shortcut", () => {
  // One incognito mode saved, but the user named a different (normal) one.
  expect(resolveIncognitoCommand([mode("fire"), mode("ghost", ["local"])], "fire").kind).toBe("not-incognito")
})

test("the applied line says it takes effect for NEW sessions", () => {
  const line = incognitoAppliedLine("ghost", "GLM 5.2 · zai")
  expect(line).toContain('"ghost"')
  expect(line).toContain("GLM 5.2 · zai")
  expect(line).toContain("NEW sessions")
  expect(line).toContain("/clear")
})
