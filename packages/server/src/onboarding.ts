import type { ModeSpec } from "./settings.ts"
import { saveMode, markSeededModes, setAdvisor, setSidekick, resetSidekickSeat, setSidekickSeats, setOnboardedAt, loadSettings } from "./settings.ts"
import { getProvider, listModelsFor, listProviders, setActiveProviderId, setSelection, type ProviderDef } from "./providers/registry.ts"
import { detectClaudeCredentials, type ClaudeCredentialDetection } from "./providers/anthropic-sdk.ts"
import { hasCodexCliAuthFile, tryImportCodexCliAuth } from "./providers/codex.ts"
import { invalidateAgent } from "./agent.ts"
import { AuthStore } from "./providers/auth-store.ts"
import { saveCustomProviders, type CustomProvider } from "./settings.ts"
export function saveCustomProvider(input: CustomProvider & { key?: string }): { id: string; label: string } {
  if (["zen", "codex", "grok", "anthropic"].includes(input.id)) throw new Error("provider id is reserved")
  const { key, ...provider } = input
  saveCustomProviders([...(loadSettings().customProviders ?? []).filter((p) => p.id !== input.id), provider])
  if (key !== undefined) AuthStore.set(input.id, { type: "api", key })
  return { id: input.id, label: input.label }
}

export interface OnboardingSuggestion { name: string; description: string; spec: ModeSpec }

interface OnboardingDependencies {
  providers: () => ProviderDef[]
  detectClaude: () => ClaudeCredentialDetection
  hasCodexCliAuth: () => boolean
  importCodexCliAuth: () => Promise<boolean>
  suggestions: (ready: Set<string>) => Promise<OnboardingSuggestion[]>
  onboardedAt: () => number | undefined
}

const onboardingDefaults: OnboardingDependencies = {
  providers: () => listProviders(),
  detectClaude: detectClaudeCredentials,
  hasCodexCliAuth: hasCodexCliAuthFile,
  importCodexCliAuth: tryImportCodexCliAuth,
  suggestions: suggestedModes,
  onboardedAt: () => loadSettings().onboardedAt,
}

/** Build the onboarding HTTP response, opportunistically adopting an existing
 * Codex CLI login before reporting provider readiness. */
export async function onboardingResponse(
  injected: Partial<OnboardingDependencies> = {},
): Promise<Response> {
  const deps = { ...onboardingDefaults, ...injected }
  const providers = deps.providers()
  const codex = providers.find((provider) => provider.id === "codex")
  let codexImportFailed = false
  if (codex && !codex.ready() && deps.hasCodexCliAuth()) {
    try {
      codexImportFailed = !(await deps.importCodexCliAuth())
    } catch {
      // The importer normally converts failures to false. Keep this endpoint
      // available even if a future importer exposes an unexpected exception.
      codexImportFailed = true
    }
  }

  const detected = deps.detectClaude()
  const statuses = providers.map((provider) => {
    if (provider.id === "anthropic") {
      return { id: provider.id, label: provider.label,
        status: detected.state === "ready" ? "inherited" : "missing", detail: detected.detail }
    }
    const ready = provider.ready()
    return { id: provider.id, label: provider.label,
      status: ready ? "ready" : "missing",
      ...(ready ? {} : { detail: provider.id === "codex" && codexImportFailed
        ? "Existing Codex CLI credentials could not be imported. Check your Codex CLI sign-in and network connection."
        : "No credentials configured." }) }
  })
  const ready = new Set(statuses.filter((provider) => provider.status !== "missing").map((provider) => provider.id))
  return new Response(JSON.stringify({ providers: statuses, onboardedAt: deps.onboardedAt(), suggestedModes: await deps.suggestions(ready) }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
}
export async function suggestedModes(ready: Set<string>): Promise<OnboardingSuggestion[]> {
  let model = "claude-opus"
  let opus = "claude-opus"
  if (ready.has("anthropic")) {
    try {
      const models = await listModelsFor("anthropic")
      opus = models.find((m) => /opus/i.test(m.id))?.id ?? opus
      model = models.find((m) => /fable/i.test(m.id))?.id ?? opus
    } catch {}
  }
  const result: OnboardingSuggestion[] = []
  if (ready.has("codex") && ready.has("anthropic")) {
    result.push({ name: "fire", description: "Anthropic Fable leads, with Codex workers and advice (Opus on frontend).", spec: { provider: "anthropic", model, effort: "low", sidekick: { provider: "codex", model: "gpt-5.6-terra", effort: "high" }, advisor: { provider: "codex", model: "gpt-5.6-sol" }, sidekickSeats: { frontend: { provider: "anthropic", model: opus } } } })
    result.push({ name: "tibo", description: "Sol leads with twin Luna sidekicks; Opus advises and owns frontend.", spec: { provider: "codex", model: "gpt-5.6-sol", effort: "high", advisor: { provider: "anthropic", model: opus }, sidekick: { provider: "codex", model: "gpt-5.6-luna", effort: "xhigh" }, sidekickSeats: { luna2: { provider: "codex", model: "gpt-5.6-luna", effort: "xhigh" }, frontend: { provider: "anthropic", model: opus } } } })
  }
  else if (ready.has("grok") && ready.has("anthropic")) {
    let grok = "grok-4.5"
    try { grok = (await listModelsFor("grok")).find((m) => /grok-4\.5/i.test(m.id))?.id ?? grok } catch {}
    result.push({ name: "fire", description: "Anthropic Fable leads, with a Grok 4.5 worker and Opus advice (Opus on frontend).", spec: { provider: "anthropic", model, effort: "low", sidekick: { provider: "grok", model: grok, effort: "high" }, advisor: { provider: "anthropic", model: opus, effort: "medium" }, sidekickSeats: { frontend: { provider: "anthropic", model: opus } } } })
  }
  else if (ready.has("codex")) result.push({ name: "default", description: "Codex Sol leads with Luna as a high-effort sidekick.", spec: { provider: "codex", model: "gpt-5.6-sol", sidekick: { provider: "codex", model: "gpt-5.6-luna", effort: "xhigh" }, advisor: null } })
  else if (ready.has("anthropic")) result.push({ name: "default", description: "Anthropic Fable leads your conversation.", spec: { provider: "anthropic", model, sidekick: null, advisor: null } })
  if (ready.has("codex")) {
    let luna = "gpt-5.6-luna"
    try { luna = (await listModelsFor("codex")).find((m) => /luna/i.test(m.id))?.id ?? luna } catch {}
    result.push({ name: "cheap", description: "Cheap executor for wrap-up work (commits, small fixes) — keeps your advisor/sidekicks unchanged.", spec: { provider: "codex", model: luna, effort: "low" } })
  } else if (ready.has("anthropic")) {
    let haiku = "claude-haiku"
    try { haiku = (await listModelsFor("anthropic")).find((m) => /haiku/i.test(m.id))?.id ?? haiku } catch {}
    result.push({ name: "cheap", description: "Cheap executor for wrap-up work (commits, small fixes) — keeps your advisor/sidekicks unchanged.", spec: { provider: "anthropic", model: haiku, effort: "low" } })
  }
  return result
}

// Keep this cheap name-only check in sync with the branches in suggestedModes.
function suggestedModeNames(ready: Set<string>): string[] {
  const names: string[] = []
  if (ready.has("codex") && ready.has("anthropic")) names.push("fire", "tibo")
  else if (ready.has("grok") && ready.has("anthropic")) names.push("fire")
  else if (ready.has("codex") || ready.has("anthropic")) names.push("default")
  if (ready.has("codex") || ready.has("anthropic")) names.push("cheap")
  return names
}

/** Seed defaults without changing any active runtime configuration. */
export async function ensureDefaultModes(ready: Set<string>): Promise<void> {
  const settings = loadSettings()
  const modes = settings.modes ?? {}
  const seeded = new Set(settings.seededModes ?? [])
  const modeNames = new Set(Object.keys(modes).map((name) => name.toLowerCase()))
  if (suggestedModeNames(ready).every((name) => modeNames.has(name) || seeded.has(name))) return
  let changed = false
  for (const suggestion of await suggestedModes(ready)) {
    if (Object.keys(modes).some((name) => name.toLowerCase() === suggestion.name.toLowerCase()) || seeded.has(suggestion.name)) continue
    saveMode(suggestion.name, suggestion.spec)
    seeded.add(suggestion.name)
    changed = true
  }
  if (changed) markSeededModes([...seeded])
}
export function applyOnboardingMode(name: string, spec: ModeSpec): void {
  if (!getProvider(spec.provider)) throw new Error(`unknown provider "${spec.provider}"`)
  saveMode(name, spec); setActiveProviderId(spec.provider); setSelection(spec.provider, { model: spec.model, effort: spec.effort, speed: spec.speed })
  if (spec.advisor) setAdvisor({ enabled: true, provider: spec.advisor.provider, model: spec.advisor.model, effort: spec.advisor.effort }); else setAdvisor({ enabled: false })
  if (spec.sidekick) setSidekick({ enabled: true, provider: spec.sidekick.provider, model: spec.sidekick.model, effort: spec.sidekick.effort }); else resetSidekickSeat()
  if (spec.sidekickSeats) setSidekickSeats(spec.sidekickSeats); else if (spec.sidekickSeats === null) setSidekickSeats({})
  invalidateAgent()
}
