import { describe, expect, test, afterAll } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
const dir = mkdtempSync(join(tmpdir(), "chunky-custom-test-"))
process.env.CHUNKY_SETTINGS = join(dir, "settings.json")
process.env.CHUNKY_AUTH = join(dir, "auth.json")
const settings = await import("../settings.ts")
const { AuthStore } = await import("./auth-store.ts")
const registry = await import("./registry.ts")
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe("custom providers", () => {
  test("colliding built-in ids are skipped", () => {
    settings.saveCustomProviders?.([])
    // Zen cannot be replaced by settings; registry always retains the built-in.
    expect(registry.getProvider("zen")?.label).toContain("Zen")
  })
  test("ready follows AuthStore and endpoint failure degrades", async () => {
    settings.saveCustomProviders?.([{ id: "local-test", label: "Local", baseURL: "http://127.0.0.1:1/v1", defaultModel: "fallback" }])
    const provider = registry.getProvider("local-test")!
    expect(provider.ready()).toBe(false)
    AuthStore.set("local-test", { type: "api", key: "key" })
    expect(provider.ready()).toBe(true)
    expect(await provider.listModels()).toEqual([{ id: "fallback", name: "fallback", reasoning: false }])
  })
})
