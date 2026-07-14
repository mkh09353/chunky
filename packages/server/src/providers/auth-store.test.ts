import { describe, expect, test, beforeEach, afterAll } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

const dir = mkdtempSync(join(tmpdir(), "chunky-auth-test-"))
process.env.CHUNKY_AUTH = join(dir, "auth.json")
const { AuthStore } = await import("./auth-store.ts")

afterAll(() => rmSync(dir, { recursive: true, force: true }))
beforeEach(() => AuthStore.remove("test"))

describe("AuthStore API credentials", () => {
  test("round trips API keys and get remains OAuth-only", () => {
    AuthStore.set("test", { type: "api", key: "secret" })
    expect(AuthStore.getApiKey("test")).toBe("secret")
    expect(AuthStore.get("test")).toBeUndefined()
  })
  test("OAuth records remain available through get", () => {
    const oauth = { type: "oauth" as const, access: "a", refresh: "r", expires: 1 }
    AuthStore.set("test", oauth)
    expect(AuthStore.get("test")).toEqual(oauth)
    expect(AuthStore.getApiKey("test")).toBeUndefined()
  })
})
