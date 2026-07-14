import { describe, expect, test, afterAll } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
const dir = mkdtempSync(join(tmpdir(), "chunky-settings-test-"))
process.env.CHUNKY_SETTINGS = join(dir, "settings.json")
const { getOnboardedAt, setOnboardedAt, loadSettings } = await import("./settings.ts")
afterAll(() => rmSync(dir, { recursive: true, force: true }))
describe("onboarding setting", () => {
  test("persists onboardedAt", () => {
    expect(getOnboardedAt()).toBeUndefined()
    expect(setOnboardedAt(12345)).toBe(12345)
    expect(getOnboardedAt()).toBe(12345)
    expect(loadSettings().onboardedAt).toBe(12345)
  })
})
