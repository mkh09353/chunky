import { describe, expect, test, afterAll } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
const dir = mkdtempSync(join(tmpdir(), "chunky-settings-test-"))
process.env.CHUNKY_SETTINGS = join(dir, "settings.json")
const { agentsMdEnabled, getOnboardedAt, setAgentsMdEnabled, setOnboardedAt, loadSettings, setPersistedProvider, setTheme } = await import("./settings.ts")
afterAll(() => rmSync(dir, { recursive: true, force: true }))
describe("onboarding setting", () => {
  test("persists onboardedAt", () => {
    expect(getOnboardedAt()).toBeUndefined()
    expect(setOnboardedAt(12345)).toBe(12345)
    expect(getOnboardedAt()).toBe(12345)
    expect(loadSettings().onboardedAt).toBe(12345)
  })
})

describe("repository instruction setting", () => {
  test("defaults enabled and persists independently per repository", () => {
    expect(agentsMdEnabled("repo-a")).toBe(true)
    expect(agentsMdEnabled("repo-b")).toBe(true)
    expect(setAgentsMdEnabled("repo-a", false)).toBe(false)
    expect(agentsMdEnabled("repo-a")).toBe(false)
    expect(agentsMdEnabled("repo-b")).toBe(true)
    expect(setAgentsMdEnabled("repo-b", true)).toBe(true)
    expect(loadSettings().repositoryInstructions?.["repo-a"]?.agentsMd).toBe(false)
    expect(loadSettings().repositoryInstructions?.["repo-b"]?.agentsMd).toBe(true)
  })
})

describe("atomic multi-server settings persistence", () => {
  test("publishes complete JSON by temp-file rename", () => {
    const path = process.env.CHUNKY_SETTINGS!
    setTheme("dark")

    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ theme: "dark" })
    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([])
  })

  test("preserves a concurrent top-level write absent from the stale cache", () => {
    const path = process.env.CHUNKY_SETTINGS!
    // This module has already loaded its cache. Simulate another runtime adding
    // a token after that load, then save a different setting from this runtime.
    writeFileSync(path, JSON.stringify({ serverToken: "other-runtime-token" }))
    setPersistedProvider("concurrent-provider")

    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
      serverToken: "other-runtime-token",
      provider: "concurrent-provider",
    })
    expect(loadSettings()).toMatchObject({ serverToken: "other-runtime-token" })
  })
})
