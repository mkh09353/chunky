import { describe, expect, test, beforeEach, afterAll } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
const dir = mkdtempSync(join(tmpdir(), "chunky-onboarding-test-"))
process.env.CHUNKY_SETTINGS = join(dir, "settings.json")
process.env.CHUNKY_AUTH = join(dir, "auth.json")
const { suggestedModes, applyOnboardingMode, onboardingResponse, saveCustomProvider } = await import("./onboarding.ts")
const settings = await import("./settings.ts")
const { AuthStore } = await import("./providers/auth-store.ts")
const { codexProvider } = await import("./providers/codex.ts")
afterAll(() => rmSync(dir, { recursive: true, force: true }))
beforeEach(() => { rmSync(process.env.CHUNKY_SETTINGS!, { force: true }); AuthStore.remove("codex") })
describe("onboarding endpoint", () => {
  test("reports plain missing detail when no Codex CLI auth file exists", async () => {
    const cli = mkdtempSync(join(tmpdir(), "chunky-onboarding-codex-cli-missing-"))
    const oldHome = process.env.CODEX_HOME
    process.env.CODEX_HOME = cli
    try {
      const response = await onboardingResponse({
        providers: () => [codexProvider],
        detectClaude: () => ({ state: "missing", detail: "not used" }),
        suggestions: async () => [],
      })
      const body = await response.json() as { providers: Array<{ id: string; status: string; detail?: string }> }
      const codex = body.providers.find((provider) => provider.id === "codex")
      expect(response.status).toBe(200)
      expect(codex).toMatchObject({ status: "missing", detail: "No credentials configured." })
    } finally {
      if (oldHome == null) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldHome
      rmSync(cli, { recursive: true, force: true })
    }
  })

  test("imports existing Codex CLI auth and reports ready", async () => {
    const cli = mkdtempSync(join(tmpdir(), "chunky-onboarding-codex-cli-"))
    const oldHome = process.env.CODEX_HOME, oldFetch = globalThis.fetch
    process.env.CODEX_HOME = cli
    writeFileSync(join(cli, "auth.json"), JSON.stringify({ tokens: { refresh_token: "cli-refresh", account_id: "acct-cli" } }))
    globalThis.fetch = (async () => new Response(JSON.stringify({ access_token: "fresh-access", refresh_token: "fresh-refresh", expires_in: 3600 }), { status: 200 })) as unknown as typeof fetch
    try {
      const response = await onboardingResponse({
        providers: () => [codexProvider],
        detectClaude: () => ({ state: "missing", detail: "not used" }),
        suggestions: async () => [],
      })
      const body = await response.json() as { providers: Array<{ id: string; status: string }> }
      expect(response.status).toBe(200)
      expect(body.providers.find((provider) => provider.id === "codex")?.status).toBe("ready")
      expect(AuthStore.get("codex")).toMatchObject({ access: "fresh-access", refresh: "fresh-refresh", accountId: "acct-cli" })
    } finally {
      globalThis.fetch = oldFetch
      if (oldHome == null) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldHome
      rmSync(cli, { recursive: true, force: true })
    }
  })

  test("import failure reports Codex missing and keeps the endpoint available", async () => {
    const cli = mkdtempSync(join(tmpdir(), "chunky-onboarding-codex-cli-fail-"))
    const oldHome = process.env.CODEX_HOME, oldFetch = globalThis.fetch
    process.env.CODEX_HOME = cli
    writeFileSync(join(cli, "auth.json"), JSON.stringify({ tokens: { refresh_token: "rejected-refresh" } }))
    globalThis.fetch = (async () => { throw new Error("network unavailable") }) as unknown as typeof fetch
    try {
      const response = await onboardingResponse({
        providers: () => [codexProvider],
        detectClaude: () => ({ state: "missing", detail: "not used" }),
        suggestions: async () => [],
      })
      const body = await response.json() as { providers: Array<{ id: string; status: string; detail?: string }> }
      const codex = body.providers.find((provider) => provider.id === "codex")
      expect(response.status).toBe(200)
      expect(codex?.status).toBe("missing")
      expect(codex?.detail).toContain("could not be imported")
    } finally {
      globalThis.fetch = oldFetch
      if (oldHome == null) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldHome
      rmSync(cli, { recursive: true, force: true })
    }
  })
})

describe("onboarding suggestions", () => {
  test("codex and anthropic suggest fire and tibo seats", async () => {
    const modes = await suggestedModes(new Set(["codex", "anthropic"]))
    expect(modes[0]?.name).toBe("fire")
    expect(modes[0]?.spec).toMatchObject({ provider: "anthropic", sidekick: { provider: "codex", model: "gpt-5.6-terra", effort: "high" }, advisor: { provider: "codex", model: "gpt-5.6-sol" } })
    expect(`${modes[0]?.spec.provider}/${modes[0]?.spec.model}`).not.toBe(`${modes[0]?.spec.advisor?.provider}/${modes[0]?.spec.advisor?.model}`)
    const tibo = modes.find((mode) => mode.name === "tibo")
    expect(tibo?.spec).toMatchObject({
      provider: "codex",
      model: "gpt-5.6-sol",
      effort: "high",
      advisor: { provider: "anthropic" },
      sidekick: { provider: "codex", model: "gpt-5.6-luna", effort: "xhigh" },
      sidekickSeats: {
        luna2: { provider: "codex", model: "gpt-5.6-luna", effort: "xhigh" },
        frontend: { provider: "anthropic" },
      },
    })
    expect(tibo?.spec.advisor?.model).toBe(tibo?.spec.sidekickSeats?.frontend?.model)
  })
  test("grok and anthropic suggest fire with a grok sidekick", async () => {
    const modes = await suggestedModes(new Set(["grok", "anthropic"]))
    expect(modes[0]?.name).toBe("fire")
    expect(modes[0]?.spec).toMatchObject({ provider: "anthropic", effort: "low", sidekick: { provider: "grok", model: "grok-4.5", effort: "high" }, advisor: { provider: "anthropic", effort: "medium" } })
    expect(modes[0]?.spec.advisor?.model).toMatch(/opus/i)
    expect(modes[0]?.spec.sidekickSeats?.frontend?.provider).toBe("anthropic")
  })
  test("single provider and empty rules", async () => {
    expect((await suggestedModes(new Set(["codex"]))) [0]?.spec.provider).toBe("codex")
    expect((await suggestedModes(new Set(["anthropic"]))) [0]?.spec.provider).toBe("anthropic")
    expect((await suggestedModes(new Set(["grok", "anthropic"]))).find((mode) => mode.name === "tibo")).toBeUndefined()
    expect((await suggestedModes(new Set(["codex"]))).find((mode) => mode.name === "tibo")).toBeUndefined()
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
