import { describe, expect, test, beforeEach, afterAll } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
const dir = mkdtempSync(join(tmpdir(), "chunky-onboarding-test-"))
process.env.CHUNKY_SETTINGS = join(dir, "settings.json")
process.env.CHUNKY_AUTH = join(dir, "auth.json")
const { suggestedModes, applyOnboardingMode, saveCustomProvider } = await import("./onboarding.ts")
const settings = await import("./settings.ts")
const { AuthStore } = await import("./providers/auth-store.ts")
afterAll(() => rmSync(dir, { recursive: true, force: true }))
beforeEach(() => { rmSync(process.env.CHUNKY_SETTINGS!, { force: true }); AuthStore.remove("codex") })
describe("onboarding suggestions", () => {
  test("codex and anthropic suggest fire seats", async () => {
    const modes = await suggestedModes(new Set(["codex", "anthropic"]))
    expect(modes[0]?.name).toBe("fire")
    expect(modes[0]?.spec).toMatchObject({ provider: "anthropic", sidekick: { provider: "codex", model: "gpt-5.6-luna", effort: "xhigh" }, advisor: { provider: "codex", model: "gpt-5.6-sol" } })
    expect(`${modes[0]?.spec.provider}/${modes[0]?.spec.model}`).not.toBe(`${modes[0]?.spec.advisor?.provider}/${modes[0]?.spec.advisor?.model}`)
  })
  test("single provider and empty rules", async () => {
    expect((await suggestedModes(new Set(["codex"]))) [0]?.spec.provider).toBe("codex")
    expect((await suggestedModes(new Set(["anthropic"]))) [0]?.spec.provider).toBe("anthropic")
    expect(await suggestedModes(new Set())).toEqual([])
  })
  test("apply saves named mode and seats", () => {
    applyOnboardingMode("fire", { provider: "codex", model: "gpt-5.6-sol", advisor: { provider: "codex", model: "gpt-5.6-luna" }, sidekick: { provider: "codex", model: "gpt-5.6-sol", effort: "xhigh" } })
    expect(settings.getMode("fire")?.model).toBe("gpt-5.6-sol")
    expect(settings.getAdvisor().model).toBe("gpt-5.6-luna")
    expect(settings.getSidekick().model).toBe("gpt-5.6-sol")
  })
  test("custom provider saves key privately and rejects reserved ids", () => {
    const result = saveCustomProvider({ id: "private", label: "Private", baseURL: "http://localhost/v1", key: "do-not-return" })
    expect(result).toEqual({ id: "private", label: "Private" })
    expect(AuthStore.getApiKey("private")).toBe("do-not-return")
    expect(settings.loadSettings().customProviders?.[0]?.id).toBe("private")
    expect(() => saveCustomProvider({ id: "zen", label: "bad", baseURL: "x", key: "secret" })).toThrow("reserved")
  })
})
