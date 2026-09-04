import type { ModeSpec } from "./settings.ts"
import { saveMode, markSeededModes, setActiveMode, setAdvisor, setSidekick, setSolo, resetSidekickSeat, setSidekickSeats, setOnboardedAt, loadSettings } from "./settings.ts"
import type { OnboardingProviderStatus, OnboardingRecommendation, OnboardingResponse, OnboardingSuggestedMode } from "@chunky/protocol"
import { getProvider, listModelsFor, listProviders, setActiveProviderId, setSelection, type ModelInfo, type ProviderDef } from "./providers/registry.ts"
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

/** Wire shape of OnboardingSuggestedMode with the server's stricter ModeSpec. */
export interface OnboardingSuggestion extends Omit<OnboardingSuggestedMode, "spec"> { spec: ModeSpec }

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
  const statuses: OnboardingProviderStatus[] = providers.map((provider) => {
    if (provider.id === "anthropic") {
      // Same predicate as the apply guard (anthropicReady): credentials detected
      // OR the provider's own OAuth check, so a fire shown unlocked never 409s.
      return { id: provider.id, label: provider.label,
        status: detected.state === "ready" || provider.ready() ? "inherited" : "missing", detail: detected.detail }
    }
    const ready = provider.ready()
    return { id: provider.id, label: provider.label,
      status: ready ? "ready" : "missing",
      ...(ready ? {} : { detail: provider.id === "codex" && codexImportFailed
        ? "Existing Codex CLI credentials could not be imported. Check your Codex CLI sign-in and network connection."
        : "No credentials configured." }) }
  })
  const ready = new Set(statuses.filter((provider) => provider.status !== "missing").map((provider) => provider.id))
  const body: Omit<OnboardingResponse, "suggestedModes"> & { suggestedModes: OnboardingSuggestion[] } = {
    providers: statuses,
    onboardedAt: deps.onboardedAt() ?? null,
    suggestedModes: await deps.suggestions(ready),
    recommended: recommendedMode(ready),
  }
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
}

// Fallbacks mirror FAMILY_FALLBACK in providers/models-catalog.ts so a locked
// (or listing-failed) fire still carries real wire ids.
const FABLE_FALLBACK = "claude-fable-5-1"
const OPUS_FALLBACK = "claude-opus-5"
const GROK_FALLBACK = "grok-4.6"
const LUNA_FALLBACK = "gpt-5.6-luna"

/** Every listing-resolved id a fire spec can reference. */
interface FireIds { fable: string; opus: string; grok: string; luna: string }

/** Model listing is injectable so suggestion tests do not depend on the
 *  machine's Claude login or the on-disk Anthropic catalog cache. */
export interface SuggestionDependencies { listModels?: (provider: string) => Promise<ModelInfo[]> }
type ModelLister = (provider: string) => Promise<ModelInfo[]>

/** The canonical recommendation: fire, on codex+anthropic unless the user
 *  already has grok (and not codex), in which case the grok variant. */
export function recommendedMode(ready: Set<string>): OnboardingRecommendation {
  const requires = ready.has("grok") && !ready.has("codex") ? ["anthropic", "grok"] : ["anthropic", "codex"]
  return { name: "fire", requires, missing: requires.filter((id) => !ready.has(id)) }
}

async function anthropicModelIds(ready: Set<string>, listModels: ModelLister): Promise<{ fable: string; opus: string }> {
  let fable = FABLE_FALLBACK, opus = OPUS_FALLBACK
  if (ready.has("anthropic")) {
    try {
      const models = await listModels("anthropic")
      opus = models.find((m) => /opus/i.test(m.id))?.id ?? opus
      fable = models.find((m) => /fable/i.test(m.id))?.id ?? fable
    } catch {}
  }
  return { fable, opus }
}

async function grokModelId(ready: Set<string>, listModels: ModelLister): Promise<string> {
  if (!ready.has("grok")) return GROK_FALLBACK
  try { return (await listModels("grok")).find((m) => /grok-4\.6/i.test(m.id))?.id ?? GROK_FALLBACK } catch { return GROK_FALLBACK }
}

/** Luna id from the Codex listing (fire's websearch seat + the cheap executor).
 *  Callers list codex at most once and share the result. */
async function lunaModelId(ready: Set<string>, listModels: ModelLister): Promise<string> {
  if (!ready.has("codex")) return LUNA_FALLBACK
  try { return (await listModels("codex")).find((m) => /luna/i.test(m.id))?.id ?? LUNA_FALLBACK } catch { return LUNA_FALLBACK }
}

async function fireIds(ready: Set<string>, listModels: ModelLister): Promise<{ variant: "codex" | "grok"; ids: FireIds }> {
  const variant = recommendedMode(ready).requires.includes("grok") ? "grok" : "codex"
  const { fable, opus } = await anthropicModelIds(ready, listModels)
  const grok = variant === "grok" ? await grokModelId(ready, listModels) : GROK_FALLBACK
  const luna = await lunaModelId(ready, listModels)
  return { variant, ids: { fable, opus, grok, luna } }
}

function fireSpec(variant: "codex" | "grok", ids: FireIds): { description: string; spec: ModeSpec } {
  if (variant === "grok") return {
    description: "Fable 5.1 leads at high effort; Grok 4.6 works as sidekick; Opus advises and owns frontend.",
    spec: { provider: "anthropic", model: ids.fable, effort: "high", sidekick: { provider: "grok", model: ids.grok, effort: "high" }, advisor: { provider: "anthropic", model: ids.opus, effort: "medium" }, sidekickSeats: { frontend: { provider: "anthropic", model: ids.opus } } },
  }
  return {
    description: "Fable 5.1 leads at high effort; Sol works as sidekick and advises; Opus owns frontend; Luna handles web search.",
    spec: {
      provider: "anthropic", model: ids.fable, effort: "high",
      sidekick: { provider: "codex", model: "gpt-5.6-sol", effort: "medium" },
      advisor: { provider: "codex", model: "gpt-5.6-sol", effort: "high" },
      sidekickSeats: {
        frontend: { provider: "anthropic", model: ids.opus, effort: "medium" },
        websearch: { provider: "codex", model: ids.luna, effort: "high", speed: "fast" },
      },
    },
  }
}

/** The fire specs shipped before the current default, used to recognise a
 *  legacy seed (no snapshot recorded) that the user never edited. */
function legacyFireSpecs(variant: "codex" | "grok", ids: FireIds): ModeSpec[] {
  // Pre-snapshot seeds resolved fable→opus→"claude-opus" when listing failed.
  const resolutions = [ids, { ...ids, fable: ids.opus }, { ...ids, fable: "claude-opus", opus: "claude-opus" }]
  return resolutions.flatMap(({ fable, opus, grok }): ModeSpec[] => variant === "grok"
    ? [{ provider: "anthropic", model: fable, effort: "low", sidekick: { provider: "grok", model: grok, effort: "high" }, advisor: { provider: "anthropic", model: opus, effort: "medium" }, sidekickSeats: { frontend: { provider: "anthropic", model: opus } } }]
    : [
      // Terra-sidekick default (shipped).
      { provider: "anthropic", model: fable, effort: "low", sidekick: { provider: "codex", model: "gpt-5.6-terra", effort: "high" }, advisor: { provider: "codex", model: "gpt-5.6-sol" }, sidekickSeats: { frontend: { provider: "anthropic", model: opus } } },
      // Interim Sol-sidekick default (no advisor/frontend effort, no websearch seat).
      { provider: "anthropic", model: fable, effort: "high", sidekick: { provider: "codex", model: "gpt-5.6-sol", effort: "medium" }, advisor: { provider: "codex", model: "gpt-5.6-sol" }, sidekickSeats: { frontend: { provider: "anthropic", model: opus } } },
    ])
}

/** Does a saved fire equal one of the shipped defaults verbatim? Model ids are
 *  read off the saved spec (no listing needed) and sanity-checked by family. */
function looksLikeLegacyFire(saved: ModeSpec | undefined): boolean {
  if (!saved || saved.provider !== "anthropic" || !/fable|opus/i.test(saved.model)) return false
  const frontend = saved.sidekickSeats?.frontend
  if (!frontend || !/opus/i.test(frontend.model)) return false
  const variant = saved.sidekick?.provider === "grok" ? "grok" : "codex"
  const ids: FireIds = { fable: saved.model, opus: frontend.model, grok: saved.sidekick?.model ?? GROK_FALLBACK, luna: LUNA_FALLBACK }
  return legacyFireSpecs(variant, ids).some((legacy) => specEquals(saved, legacy))
}

export async function suggestedModes(ready: Set<string>, deps: SuggestionDependencies = {}): Promise<OnboardingSuggestion[]> {
  const listModels = deps.listModels ?? ((provider: string) => listModelsFor(provider))
  const recommended = recommendedMode(ready)
  const { variant, ids } = await fireIds(ready, listModels)
  const { fable, opus, luna } = ids
  const result: OnboardingSuggestion[] = []
  // Fire is always first, locked until every provider it references is ready.
  const fire = fireSpec(variant, ids)
  result.push({ name: "fire", ...fire, ...(recommended.missing.length ? { locked: true, missingProviders: recommended.missing } : {}) })
  if (ready.has("codex") && ready.has("anthropic")) {
    result.push({ name: "tibo", description: "Sol leads with twin Luna sidekicks; Opus advises and owns frontend.", spec: { provider: "codex", model: "gpt-5.6-sol", effort: "high", advisor: { provider: "anthropic", model: opus }, sidekick: { provider: "codex", model: "gpt-5.6-luna", effort: "xhigh" }, sidekickSeats: { luna2: { provider: "codex", model: "gpt-5.6-luna", effort: "xhigh" }, frontend: { provider: "anthropic", model: opus } } } })
  }
  else if (ready.has("grok") && ready.has("anthropic")) { /* fire (grok variant) only */ }
  else if (ready.has("codex")) result.push({ name: "default", description: "Codex Sol leads with Luna as a high-effort sidekick.", spec: { provider: "codex", model: "gpt-5.6-sol", sidekick: { provider: "codex", model: "gpt-5.6-luna", effort: "xhigh" }, advisor: null } })
  else if (ready.has("anthropic")) result.push({ name: "default", description: "Anthropic Fable leads your conversation.", spec: { provider: "anthropic", model: fable, sidekick: null, advisor: null } })
  if (ready.has("codex")) {
    result.push({ name: "cheap", description: "Cheap executor for wrap-up work (commits, small fixes) — keeps your advisor/sidekicks unchanged.", spec: { provider: "codex", model: luna, effort: "low" } })
  } else if (ready.has("anthropic")) {
    let haiku = "claude-haiku"
    try { haiku = (await listModels("anthropic")).find((m) => /haiku/i.test(m.id))?.id ?? haiku } catch {}
    result.push({ name: "cheap", description: "Cheap executor for wrap-up work (commits, small fixes) — keeps your advisor/sidekicks unchanged.", spec: { provider: "anthropic", model: haiku, effort: "low" } })
  }
  return result
}

// Keep this cheap name-only check in sync with the branches in suggestedModes.
// Fire is always emitted; `unlocked` is the subset ensureDefaultModes may seed.
function suggestedModeNames(ready: Set<string>): { all: string[]; unlocked: string[] } {
  const all = ["fire"]
  if (ready.has("codex") && ready.has("anthropic")) all.push("tibo")
  else if (ready.has("grok") && ready.has("anthropic")) { /* fire only */ }
  else if (ready.has("codex") || ready.has("anthropic")) all.push("default")
  if (ready.has("codex") || ready.has("anthropic")) all.push("cheap")
  const fireLocked = recommendedMode(ready).missing.length > 0
  return { all, unlocked: fireLocked ? all.filter((name) => name !== "fire") : all }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).filter((key) => (value as Record<string, unknown>)[key] !== undefined).sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`
  }
  return JSON.stringify(value)
}
export function specEquals(a: ModeSpec | undefined, b: ModeSpec | undefined): boolean {
  return a !== undefined && b !== undefined && canonical(a) === canonical(b)
}

/** Seed defaults without changing any active runtime configuration. Seeds
 *  that the user never edited (saved spec still deep-equals its recorded
 *  snapshot, or a known legacy default) are upgraded to the current default;
 *  a customized mode is never touched, and a locked fire is never seeded. */
export async function ensureDefaultModes(ready: Set<string>, deps: SuggestionDependencies = {}): Promise<void> {
  const listModels = deps.listModels ?? ((provider: string) => listModelsFor(provider))
  const settings = loadSettings()
  const modes = settings.modes ?? {}
  const seeded = new Set(settings.seededModes ?? [])
  const snapshots = settings.seededModeSpecs ?? {}
  const savedKey = (name: string) => Object.keys(modes).find((key) => key.toLowerCase() === name.toLowerCase())
  const names = suggestedModeNames(ready)
  // A fire applied through onboarding on an older server was never marked
  // seeded; it still upgrades when it matches a shipped default verbatim.
  const upgradeCandidate = (name: string) => {
    const key = savedKey(name)
    if (key === undefined) return false
    if (!seeded.has(name)) return name === "fire" && looksLikeLegacyFire(modes[key])
    return snapshots[name] === undefined || specEquals(modes[key], snapshots[name])
  }
  if (names.unlocked.every((name) => savedKey(name) !== undefined || seeded.has(name)) && !names.unlocked.some(upgradeCandidate)) return
  const specs: Record<string, ModeSpec> = {}
  for (const suggestion of await suggestedModes(ready, { listModels })) {
    if (suggestion.locked) continue
    const key = savedKey(suggestion.name)
    if (key === undefined) {
      if (seeded.has(suggestion.name)) continue // deleted by the user; deletion is permanent
      saveMode(suggestion.name, suggestion.spec)
      seeded.add(suggestion.name)
      specs[suggestion.name] = suggestion.spec
      continue
    }
    const saved = modes[key]
    const snapshot = snapshots[suggestion.name]
    const legacy = suggestion.name === "fire" && looksLikeLegacyFire(saved)
    if (!seeded.has(suggestion.name) && !legacy) continue // user-authored mode of the same name
    const untouched = snapshot !== undefined ? specEquals(saved, snapshot) : legacy
    if (!untouched || specEquals(saved, suggestion.spec)) {
      // Record the snapshot for a legacy seed that still matches so later checks stay cheap.
      if (snapshot === undefined && untouched) { specs[suggestion.name] = saved!; seeded.add(suggestion.name) }
      continue
    }
    saveMode(key, suggestion.spec)
    seeded.add(suggestion.name)
    specs[suggestion.name] = suggestion.spec
    // An upgraded default that is the pinned global mode must take effect now,
    // otherwise the new pairing is invisible until someone re-applies it.
    if (settings.activeMode?.toLowerCase() === suggestion.name.toLowerCase()) applySpecGlobally(suggestion.spec)
  }
  if (Object.keys(specs).length || seeded.size !== (settings.seededModes ?? []).length) markSeededModes([...seeded], specs)
}

/** Thrown by applyOnboardingMode when the spec references a provider without
 *  credentials; the HTTP route maps it to 409. */
export class ModeProvidersNotReadyError extends Error {
  constructor(public readonly providers: string[]) {
    super(`provider${providers.length === 1 ? "" : "s"} not ready: ${providers.join(", ")}`)
    this.name = "ModeProvidersNotReadyError"
  }
}

function referencedProviders(spec: ModeSpec): string[] {
  const ids = [spec.provider, spec.advisor?.provider, spec.sidekick?.provider, ...Object.values(spec.sidekickSeats ?? {}).map((seat) => seat.provider)]
  return [...new Set(ids.filter((id): id is string => typeof id === "string" && id.length > 0))]
}

/** Save + pin + apply a mode globally. Rejects (409 upstream) when any provider
 *  the spec references — executor, advisor, sidekick, every named seat — is
 *  not ready, so onboarding never pins a mode that cannot run. */
export function applyOnboardingMode(name: string, spec: ModeSpec, deps: { ready?: (id: string) => boolean } = {}): void {
  if (!getProvider(spec.provider)) throw new Error(`unknown provider "${spec.provider}"`)
  const isReady = deps.ready ?? ((id: string) => (getProvider(id)?.ready() ?? false) || (id === "anthropic" && detectClaudeCredentials().state === "ready"))
  const missing = referencedProviders(spec).filter((id) => !isReady(id))
  if (missing.length) throw new ModeProvidersNotReadyError(missing)
  saveMode(name, spec); setActiveMode(name); setSolo(false)
  // Onboarding applies a shipped default: record it as a seed with a snapshot so
  // ensureDefaultModes can upgrade it later if the user never edits it.
  markSeededModes([...new Set([...(loadSettings().seededModes ?? []), name])], { [name]: spec })
  applySpecGlobally(spec)
}

/** Write a mode's pairing into the global executor/advisor/sidekick/seat
 *  settings (the same writes the global `/api/modes/:name/apply` performs). */
function applySpecGlobally(spec: ModeSpec): void {
  setActiveProviderId(spec.provider); setSelection(spec.provider, { model: spec.model, effort: spec.effort, speed: spec.speed })
  if (spec.advisor) setAdvisor({ enabled: true, provider: spec.advisor.provider, model: spec.advisor.model, effort: spec.advisor.effort }); else setAdvisor({ enabled: false })
  if (spec.sidekick) setSidekick({ enabled: true, provider: spec.sidekick.provider, model: spec.sidekick.model, effort: spec.sidekick.effort }); else resetSidekickSeat()
  if (spec.sidekickSeats) setSidekickSeats(spec.sidekickSeats); else if (spec.sidekickSeats === null) setSidekickSeats({})
  invalidateAgent()
}
