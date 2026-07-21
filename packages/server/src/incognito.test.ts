import { describe, expect, test, beforeEach } from "bun:test"
import { clearIncognitoSessions, assertSelectionAllowed, incognitoAllowlistFor, isIncognitoSession, markSessionIncognito, providerScope, rehydrateIncognitoSessions, validateIncognitoMode } from "./incognito.ts"
import { saveCustomProviders } from "./settings.ts"

beforeEach(() => {
  clearIncognitoSessions()
  saveCustomProviders([
    { id: "normal", label: "Normal", baseURL: "http://normal", scope: "normal" },
    { id: "secret", label: "Secret", baseURL: "http://secret", scope: "incognito" },
  ])
})

describe("incognito selection guard", () => {
  test("null session only enforces provider scope", () => {
    expect(() => assertSelectionAllowed(null, { provider: "secret" })).toThrow("provider secret is incognito-only")
    expect(() => assertSelectionAllowed(null, { provider: "missing" })).not.toThrow()
  })
  test("enforces an incognito session allowlist", () => {
    markSessionIncognito("s", ["allowed"])
    expect(() => assertSelectionAllowed("s", { provider: "blocked" })).toThrow("provider blocked not in incognito allowlist [allowed]")
    expect(() => assertSelectionAllowed("s", { provider: "allowed" })).not.toThrow()
  })
  test("custom scope and built-in default", () => {
    expect(providerScope("normal")).toBe("normal")
    expect(providerScope("secret")).toBe("incognito")
    expect(providerScope("anthropic")).toBe("both")
  })
})

describe("incognito mode validation", () => {
  const base = { provider: "allowed", model: "m" }
  test("rejects empty allowlist", () => expect(() => validateIncognitoMode({ ...base, incognito: { allow: [] } })).toThrow("allowlist"))
  test("rejects normal provider in allowlist", () => expect(() => validateIncognitoMode({ ...base, incognito: { allow: ["normal"] } })).toThrow("scope normal"))
  test("rejects every referenced provider outside allowlist", () => {
    for (const extra of [
      { advisor: { provider: "outside", model: "m" } },
      { sidekick: { provider: "outside", model: "m" } },
      { sidekickSeats: { seat: { provider: "outside", model: "m" } } },
    ]) expect(() => validateIncognitoMode({ ...base, ...extra, incognito: { allow: ["allowed"] } })).toThrow("outside")
  })
  test("accepts a valid complete mode", () => expect(() => validateIncognitoMode({ provider: "allowed", model: "m", advisor: { provider: "secret", model: "m" }, sidekick: { provider: "allowed", model: "m" }, sidekickSeats: { seat: { provider: "secret", model: "m" } }, incognito: { allow: ["allowed", "secret"] } })).not.toThrow())
})

test("rehydrateIncognitoSessions restores flags and allowlists", () => {
  rehydrateIncognitoSessions([{ sessionId: "s", incognito: 1, incognitoAllow: '["a"]' }, { sessionId: "n", incognito: 0, incognitoAllow: '["b"]' }])
  expect(isIncognitoSession("s")).toBe(true)
  expect(incognitoAllowlistFor("s")).toEqual(["a"])
  expect(isIncognitoSession("n")).toBe(false)
})
