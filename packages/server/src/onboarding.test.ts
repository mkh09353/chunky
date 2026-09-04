import { describe, expect, test, beforeEach, afterAll } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
const dir = mkdtempSync(join(tmpdir(), "chunky-onboarding-test-"))
process.env.CHUNKY_SETTINGS = join(dir, "settings.json")
process.env.CHUNKY_AUTH = join(dir, "auth.json")
const { suggestedModes, applyOnboardingMode, onboardingResponse, saveCustomProvider, ensureDefaultModes, recommendedMode, ModeProvidersNotReadyError } = await import("./onboarding.ts")
const settings = await import("./settings.ts")
const { AuthStore } = await import("./providers/auth-store.ts")
const { codexProvider } = await import("./providers/codex.ts")
afterAll(() => rmSync(dir, { recursive: true, force: true }))
// loadSettings caches by path, so each test gets a fresh settings file.
let settingsSerial = 0
beforeEach(() => { process.env.CHUNKY_SETTINGS = join(dir, `settings-${settingsSerial++}.json`); AuthStore.remove("codex") })
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

type ModeSpec = Parameters<typeof settings.saveMode>[1]
const FIRE_CODEX: ModeSpec = {
  provider: "anthropic", model: "claude-fable-5-1", effort: "high",
  sidekick: { provider: "codex", model: "gpt-5.6-sol", effort: "medium" },
  advisor: { provider: "codex", model: "gpt-5.6-sol", effort: "high" },
  sidekickSeats: {
    frontend: { provider: "anthropic", model: "claude-opus-5", effort: "medium" },
    websearch: { provider: "codex", model: "gpt-5.6-luna", effort: "high", speed: "fast" },
  },
}
const FIRE_DESCRIPTION = "Fable 5.1 leads at high effort; Sol works as sidekick and advises; Opus owns frontend; Luna handles web search."
// The interim default this tree carried before websearch/effort landed.
const INTERIM_FIRE_CODEX: ModeSpec = {
  provider: "anthropic", model: "claude-fable-5-1", effort: "high",
  sidekick: { provider: "codex", model: "gpt-5.6-sol", effort: "medium" },
  advisor: { provider: "codex", model: "gpt-5.6-sol" },
  sidekickSeats: { frontend: { provider: "anthropic", model: "claude-opus-5" } },
}
const LEGACY_FIRE_CODEX: ModeSpec = {
  provider: "anthropic", model: "claude-fable-5-1", effort: "low",
  sidekick: { provider: "codex", model: "gpt-5.6-terra", effort: "high" },
  advisor: { provider: "codex", model: "gpt-5.6-sol" },
  sidekickSeats: { frontend: { provider: "anthropic", model: "claude-opus-5" } },
}
const allReady = () => true
const CATALOG: Record<string, string[]> = {
  anthropic: ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5", "claude-fable-5-1"],
  codex: ["gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.6-terra"],
  grok: ["grok-4.6", "grok-4"],
}
const catalog = { listModels: async (provider: string) => (CATALOG[provider] ?? []).map((id) => ({ id, name: id, reasoning: true })) }
const throwing = { listModels: async (provider: string): Promise<never> => { throw new Error(`${provider}: listing unavailable`) } }

describe("onboarding suggestions", () => {
  test("codex and anthropic suggest fire (Sol medium sidekick, Luna websearch seat) and tibo seats", async () => {
    const modes = await suggestedModes(new Set(["codex", "anthropic"]), catalog)
    expect(modes[0]?.name).toBe("fire")
    expect(modes[0]?.spec).toEqual(FIRE_CODEX)
    expect(modes[0]?.description).toBe(FIRE_DESCRIPTION)
    expect(modes[0]?.locked).toBeUndefined()
    expect(modes[0]?.missingProviders).toBeUndefined()
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
    expect(modes.map((mode) => mode.name)).toEqual(["fire", "tibo", "cheap"])
  })
  test("grok and anthropic suggest fire with a grok sidekick at high lead effort", async () => {
    const modes = await suggestedModes(new Set(["grok", "anthropic"]), catalog)
    expect(modes[0]?.name).toBe("fire")
    expect(modes[0]?.locked).toBeUndefined()
    expect(modes[0]?.spec).toMatchObject({ provider: "anthropic", model: "claude-fable-5-1", effort: "high", sidekick: { provider: "grok", model: "grok-4.6", effort: "high" }, advisor: { provider: "anthropic", model: "claude-opus-5", effort: "medium" } })
    expect(modes[0]?.spec.sidekickSeats?.frontend).toEqual({ provider: "anthropic", model: "claude-opus-5" })
    expect(modes.map((mode) => mode.name)).toEqual(["fire", "cheap"])
  })
  test("fire is always first and locked until its providers are ready", async () => {
    const codexOnly = await suggestedModes(new Set(["codex"]), catalog)
    expect(codexOnly.map((mode) => mode.name)).toEqual(["fire", "default", "cheap"])
    expect(codexOnly[0]).toMatchObject({ name: "fire", locked: true, missingProviders: ["anthropic"], spec: FIRE_CODEX })
    expect(codexOnly[1]?.spec.provider).toBe("codex")
    const anthropicOnly = await suggestedModes(new Set(["anthropic"]), catalog)
    expect(anthropicOnly.map((mode) => mode.name)).toEqual(["fire", "default", "cheap"])
    expect(anthropicOnly[0]).toMatchObject({ name: "fire", locked: true, missingProviders: ["codex"], spec: FIRE_CODEX })
    expect(anthropicOnly[1]?.spec).toEqual({ provider: "anthropic", model: "claude-fable-5-1", sidekick: null, advisor: null })
    const grokOnly = await suggestedModes(new Set(["grok"]), catalog)
    expect(grokOnly.map((mode) => mode.name)).toEqual(["fire"])
    expect(grokOnly[0]).toMatchObject({ locked: true, missingProviders: ["anthropic"], spec: { model: "claude-fable-5-1", sidekick: { provider: "grok" } } })
    const none = await suggestedModes(new Set(), catalog)
    expect(none.map((mode) => mode.name)).toEqual(["fire"])
    expect(none[0]).toEqual({ name: "fire", description: FIRE_DESCRIPTION, spec: FIRE_CODEX, locked: true, missingProviders: ["anthropic", "codex"] })
    expect((await suggestedModes(new Set(["grok", "anthropic"]), catalog)).find((mode) => mode.name === "tibo")).toBeUndefined()
    expect(codexOnly.find((mode) => mode.name === "tibo")).toBeUndefined()
  })
  test("fire keeps the FAMILY_FALLBACK ids when the Anthropic listing throws", async () => {
    const modes = await suggestedModes(new Set(["codex", "anthropic"]), throwing)
    expect(modes[0]?.spec).toEqual(FIRE_CODEX)
    expect(modes.find((mode) => mode.name === "cheap")?.spec.model).toBe("gpt-5.6-luna")
    const grokModes = await suggestedModes(new Set(["grok", "anthropic"]), throwing)
    expect(grokModes[0]?.spec).toMatchObject({ model: "claude-fable-5-1", sidekick: { model: "grok-4.6" }, advisor: { model: "claude-opus-5" }, sidekickSeats: { frontend: { model: "claude-opus-5" } } })
    expect(grokModes.find((mode) => mode.name === "cheap")?.spec.model).toBe("claude-haiku")
  })
  test("fire resolves listed Anthropic ids when present", async () => {
    const listed = { listModels: async (provider: string) => provider === "anthropic" ? [{ id: "opus[1m]", name: "Opus", reasoning: true }, { id: "claude-fable-5-1[1m]", name: "Fable", reasoning: true }] : [] }
    const modes = await suggestedModes(new Set(["codex", "anthropic"]), listed)
    expect(modes[0]?.spec).toMatchObject({ model: "claude-fable-5-1[1m]", sidekickSeats: { frontend: { model: "opus[1m]" }, websearch: { model: "gpt-5.6-luna" } } })
  })
  test("fire's websearch seat and cheap share one Codex listing for the Luna id", async () => {
    const calls: string[] = []
    const counting = { listModels: async (provider: string) => { calls.push(provider); return provider === "codex" ? [{ id: "gpt-5.6-luna-2", name: "Luna", reasoning: true }] : [] } }
    const modes = await suggestedModes(new Set(["codex", "anthropic"]), counting)
    expect(modes[0]?.spec.sidekickSeats?.websearch).toEqual({ provider: "codex", model: "gpt-5.6-luna-2", effort: "high", speed: "fast" })
    expect(modes.find((mode) => mode.name === "cheap")?.spec.model).toBe("gpt-5.6-luna-2")
    expect(calls.filter((provider) => provider === "codex")).toHaveLength(1)
    // No Codex listing when codex is not ready: the websearch seat keeps the fallback id.
    calls.length = 0
    const anthropicOnly = await suggestedModes(new Set(["anthropic"]), counting)
    expect(anthropicOnly[0]?.spec.sidekickSeats?.websearch?.model).toBe("gpt-5.6-luna")
    expect(calls).not.toContain("codex")
  })
  test("recommendation requires anthropic+codex unless grok is the only worker provider", () => {
    expect(recommendedMode(new Set())).toEqual({ name: "fire", requires: ["anthropic", "codex"], missing: ["anthropic", "codex"] })
    expect(recommendedMode(new Set(["codex"]))).toEqual({ name: "fire", requires: ["anthropic", "codex"], missing: ["anthropic"] })
    expect(recommendedMode(new Set(["anthropic", "codex"]))).toEqual({ name: "fire", requires: ["anthropic", "codex"], missing: [] })
    expect(recommendedMode(new Set(["grok"]))).toEqual({ name: "fire", requires: ["anthropic", "grok"], missing: ["anthropic"] })
    expect(recommendedMode(new Set(["grok", "anthropic"]))).toEqual({ name: "fire", requires: ["anthropic", "grok"], missing: [] })
    expect(recommendedMode(new Set(["grok", "codex"]))).toEqual({ name: "fire", requires: ["anthropic", "codex"], missing: ["anthropic"] })
  })
  test("onboarding response carries recommended + locked fire with zero providers ready", async () => {
    const response = await onboardingResponse({
      providers: () => [codexProvider],
      detectClaude: () => ({ state: "missing", detail: "not used" }),
      hasCodexCliAuth: () => false,
      suggestions: (ready) => suggestedModes(ready, catalog),
    })
    const body = await response.json() as { onboardedAt: number | null; suggestedModes: Array<{ name: string; description: string; locked?: boolean; missingProviders?: string[]; spec: unknown }>; recommended: unknown }
    expect(body.onboardedAt).toBeNull()
    expect(body.recommended).toEqual({ name: "fire", requires: ["anthropic", "codex"], missing: ["anthropic", "codex"] })
    expect(body.suggestedModes[0]).toEqual({ name: "fire", description: expect.any(String), spec: FIRE_CODEX, locked: true, missingProviders: ["anthropic", "codex"] })
  })
  test("onboarding response uses the grok variant when grok is ready and codex is not", async () => {
    const response = await onboardingResponse({
      providers: () => [{ ...codexProvider, id: "grok", label: "Grok", ready: () => true }, { ...codexProvider, id: "anthropic", label: "Anthropic", ready: () => false }],
      detectClaude: () => ({ state: "ready", detail: "claude cli" }),
      hasCodexCliAuth: () => false,
      suggestions: (ready) => suggestedModes(ready, catalog),
    })
    const body = await response.json() as { suggestedModes: Array<{ name: string; locked?: boolean; spec: { sidekick?: { provider: string } } }>; recommended: unknown }
    expect(body.recommended).toEqual({ name: "fire", requires: ["anthropic", "grok"], missing: [] })
    expect(body.suggestedModes[0]?.name).toBe("fire")
    expect(body.suggestedModes[0]?.locked).toBeUndefined()
    expect(body.suggestedModes[0]?.spec.sidekick?.provider).toBe("grok")
  })
  test("apply saves named mode and seats, pins the mode, and leaves solo off", () => {
    settings.setSolo(true)
    applyOnboardingMode("fire", { provider: "codex", model: "gpt-5.6-sol", advisor: { provider: "codex", model: "gpt-5.6-luna" }, sidekick: { provider: "codex", model: "gpt-5.6-sol", effort: "xhigh" } }, { ready: (id) => id === "codex" })
    expect(settings.getMode("fire")?.model).toBe("gpt-5.6-sol")
    expect(settings.getAdvisor().model).toBe("gpt-5.6-luna")
    expect(settings.getSidekick().model).toBe("gpt-5.6-sol")
    expect(settings.loadSettings().activeMode).toBe("fire")
    expect(settings.loadSettings().solo).toBe(false)
  })
  test("apply rejects a spec whose providers are not ready (409 upstream) and saves nothing", () => {
    expect(() => applyOnboardingMode("fire", FIRE_CODEX, { ready: (id) => id === "codex" })).toThrow(ModeProvidersNotReadyError)
    try { applyOnboardingMode("fire", FIRE_CODEX, { ready: (id) => id === "codex" }) }
    catch (err) { expect((err as InstanceType<typeof ModeProvidersNotReadyError>).providers).toEqual(["anthropic"]) }
    // Named seats count too.
    expect(() => applyOnboardingMode("fire", { ...FIRE_CODEX, sidekickSeats: { frontend: { provider: "grok", model: "grok-4.6" } } }, { ready: (id) => id === "codex" || id === "anthropic" }))
      .toThrow("grok")
    // Default readiness comes from the registry: codex has no credentials here.
    expect(() => applyOnboardingMode("fire", { provider: "codex", model: "gpt-5.6-sol" })).toThrow(ModeProvidersNotReadyError)
    expect(settings.getMode("fire")).toBeUndefined()
    expect(settings.loadSettings().activeMode).toBeUndefined()
    expect(() => applyOnboardingMode("fire", { provider: "nope", model: "x" }, { ready: allReady })).toThrow("unknown provider")
  })
  test("custom provider saves key privately and rejects reserved ids", () => {
    const result = saveCustomProvider({ id: "private", label: "Private", baseURL: "http://localhost/v1", key: "do-not-return" })
    expect(result).toEqual({ id: "private", label: "Private" })
    expect(AuthStore.getApiKey("private")).toBe("do-not-return")
    expect(settings.loadSettings().customProviders?.[0]?.id).toBe("private")
    expect(() => saveCustomProvider({ id: "zen", label: "bad", baseURL: "x", key: "secret" })).toThrow("reserved")
  })
  test("custom provider can register metadata without replacing its existing key", () => {
    AuthStore.set("metadata-only", { type: "api", key: "existing-secret" })
    const result = saveCustomProvider({ id: "metadata-only", label: "Metadata only", baseURL: "http://localhost/v1", defaultModel: "example" })
    expect(result).toEqual({ id: "metadata-only", label: "Metadata only" })
    expect(AuthStore.getApiKey("metadata-only")).toBe("existing-secret")
    expect(settings.loadSettings().customProviders?.find((provider) => provider.id === "metadata-only")).toEqual({
      id: "metadata-only", label: "Metadata only", baseURL: "http://localhost/v1", defaultModel: "example",
    })
  })
})

describe("ensureDefaultModes", () => {
  const both = new Set(["codex", "anthropic"])
  test("seeds unlocked suggestions with snapshots and never a locked fire", async () => {
    await ensureDefaultModes(new Set(["codex"]), catalog)
    expect(settings.getMode("fire")).toBeUndefined()
    expect(settings.loadSettings().seededModes).toEqual(["default", "cheap"])
    expect(settings.loadSettings().seededModeSpecs?.default).toEqual(settings.getMode("default")!)
    await ensureDefaultModes(new Set(), catalog)
    expect(settings.getMode("fire")).toBeUndefined()
    await ensureDefaultModes(both, catalog)
    expect(settings.getMode("fire")).toEqual(FIRE_CODEX)
    expect(settings.loadSettings().seededModes).toEqual(["default", "cheap", "fire", "tibo"])
    expect(settings.loadSettings().seededModeSpecs?.fire).toEqual(FIRE_CODEX)
  })
  test("upgrades an unedited seed whose saved spec still matches its snapshot", async () => {
    const stale = { ...FIRE_CODEX, effort: "low" as const }
    settings.saveMode("fire", stale)
    settings.markSeededModes(["fire"], { fire: stale })
    await ensureDefaultModes(both, catalog)
    expect(settings.getMode("fire")).toEqual(FIRE_CODEX)
    expect(settings.loadSettings().seededModeSpecs?.fire).toEqual(FIRE_CODEX)
    expect(settings.loadSettings().seededModes).toEqual(["fire", "tibo", "cheap"])
  })
  test("upgrades a legacy fire seed (no snapshot) that equals the previous shipped default", async () => {
    settings.saveMode("fire", LEGACY_FIRE_CODEX)
    settings.markSeededModes(["fire"])
    await ensureDefaultModes(both, catalog)
    expect(settings.getMode("fire")).toEqual(FIRE_CODEX)
    expect(settings.loadSettings().seededModeSpecs?.fire).toEqual(FIRE_CODEX)
  })
  test("upgrades the interim Sol-sidekick fire seed, with or without its snapshot", async () => {
    settings.saveMode("fire", INTERIM_FIRE_CODEX)
    settings.markSeededModes(["fire"])
    await ensureDefaultModes(both, catalog)
    expect(settings.getMode("fire")).toEqual(FIRE_CODEX)
    expect(settings.loadSettings().seededModeSpecs?.fire).toEqual(FIRE_CODEX)

    settings.saveMode("fire", INTERIM_FIRE_CODEX)
    settings.markSeededModes(["fire"], { fire: INTERIM_FIRE_CODEX })
    await ensureDefaultModes(both, catalog)
    expect(settings.getMode("fire")).toEqual(FIRE_CODEX)
    expect(settings.loadSettings().seededModeSpecs?.fire).toEqual(FIRE_CODEX)
  })
  test("never touches a customized mode, with or without a snapshot", async () => {
    const custom: ModeSpec = { ...LEGACY_FIRE_CODEX, advisor: { provider: "codex", model: "gpt-5.6-luna" } }
    settings.saveMode("fire", custom)
    settings.markSeededModes(["fire"])
    await ensureDefaultModes(both, catalog)
    expect(settings.getMode("fire")).toEqual(custom)
    expect(settings.loadSettings().seededModeSpecs?.fire).toBeUndefined()

    const edited = { ...FIRE_CODEX, effort: "max" as const }
    settings.saveMode("tibo", edited)
    settings.markSeededModes(["fire", "tibo"], { tibo: FIRE_CODEX })
    await ensureDefaultModes(both, catalog)
    expect(settings.getMode("tibo")).toEqual(edited)
    expect(settings.loadSettings().seededModeSpecs?.tibo).toEqual(FIRE_CODEX)

    // A user-authored mode that merely shares a builtin name is never seeded over.
    settings.saveMode("cheap", { provider: "codex", model: "gpt-5.6-terra" })
    await ensureDefaultModes(both, catalog)
    expect(settings.getMode("cheap")).toEqual({ provider: "codex", model: "gpt-5.6-terra" })
  })
  test("upgrades a legacy fire that onboarding applied on an older server (never marked seeded)", async () => {
    settings.saveMode("fire", LEGACY_FIRE_CODEX)
    await ensureDefaultModes(both, catalog)
    expect(settings.getMode("fire")).toEqual(FIRE_CODEX)
    expect(settings.loadSettings().seededModes).toContain("fire")
    expect(settings.loadSettings().seededModeSpecs?.fire).toEqual(FIRE_CODEX)

    // A user-authored fire that matches no shipped default is left alone and not adopted.
    const custom: ModeSpec = { ...LEGACY_FIRE_CODEX, effort: "max" }
    settings.saveMode("fire", custom)
    settings.markSeededModes([], {})
    await ensureDefaultModes(both, catalog)
    expect(settings.getMode("fire")).toEqual(custom)
    expect(settings.loadSettings().seededModes ?? []).not.toContain("fire")
  })
  test("a mode applied through onboarding is recorded as a seed with a snapshot", () => {
    applyOnboardingMode("fire", FIRE_CODEX, { ready: allReady })
    expect(settings.loadSettings().seededModes).toContain("fire")
    expect(settings.loadSettings().seededModeSpecs?.fire).toEqual(FIRE_CODEX)
  })
  test("upgrading the pinned global mode re-applies the new pairing", async () => {
    applyOnboardingMode("fire", LEGACY_FIRE_CODEX, { ready: allReady })
    expect(settings.getSidekickSeats().websearch).toBeUndefined()
    await ensureDefaultModes(both, catalog)
    expect(settings.getMode("fire")).toEqual(FIRE_CODEX)
    expect(settings.getSidekick().model).toBe(FIRE_CODEX.sidekick!.model)
    expect(settings.getAdvisor().effort).toBe("high")
    expect(settings.getSidekickSeats().websearch?.model).toBe(FIRE_CODEX.sidekickSeats!.websearch!.model)

    // Not the active mode → the saved spec upgrades but the live pairing is untouched.
    settings.saveMode("tibo", { ...FIRE_CODEX, effort: "low" })
    settings.markSeededModes(["fire", "tibo"], { fire: FIRE_CODEX, tibo: { ...FIRE_CODEX, effort: "low" } })
    settings.setActiveMode("fire")
    settings.setSelectionFor("anthropic", { effort: "max" })
    await ensureDefaultModes(both, catalog)
    expect(settings.getMode("tibo")?.effort).not.toBe("low")
    expect(settings.loadSettings().selections?.anthropic?.effort).toBe("max")
  })
  test("a deleted seed stays deleted", async () => {
    settings.markSeededModes(["fire", "tibo", "cheap"])
    await ensureDefaultModes(both, catalog)
    expect(settings.listModes()).toEqual([])
  })
})
