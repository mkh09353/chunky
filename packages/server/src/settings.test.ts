import { describe, expect, test, afterAll } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
const dir = mkdtempSync(join(tmpdir(), "chunky-settings-test-"))
process.env.CHUNKY_SETTINGS = join(dir, "settings.json")
const { agentsMdEnabled, getOnboardedAt, setAgentsMdEnabled, setOnboardedAt, loadSettings } = await import("./settings.ts")
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
