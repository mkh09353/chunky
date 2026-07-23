// Provider registry — the seam OAuth providers plug into, now also the seam the
// /model picker plugs into.
//
// Each provider owns: how it authenticates (ready/login/token injection), what
// MODELS it can serve (listModels), and how to build a ready BaseChatModel for a
// chosen model + reasoning options (buildModel). The rest of the app only calls
// resolveModel()/listProviders()/listModelsFor() and the selection getters — it
// never sees how a provider authenticates or which models.dev entry backs a
// model. Selection (active provider + per-provider model/effort/speed) is
// persisted via ./settings so it survives a restart.
import type { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { ChatOpenAI } from "@langchain/openai"
import type { LoginInitiation } from "@chunky/protocol"
import { enrichModels, type ModelInfo } from "./models-catalog.ts"
import { chatOptionsFor } from "./model-options.ts"
import { assertSelectionAllowed, incognitoAllowlistFor, isIncognitoSession, providerScope } from "../incognito.ts"
import {
  getAdvisor,
  getEffectiveReview,
  getSidekick,
  getSidekickSeats,
  persistedProvider,
  selectionFor,
  setPersistedProvider,
  setSelectionFor,
  modelCatalogFor,
  type Effort,
  type ModelSelection,
  type Speed,
  loadSettings,
  type CustomProvider,
} from "../settings.ts"
import { AuthStore } from "./auth-store.ts"

export type { LoginInitiation } from "@chunky/protocol"
export type { ModelInfo } from "./models-catalog.ts"
export type { Effort, ModelSelection, Speed } from "../settings.ts"

/** A complete, immutable model choice for one agent run. Keeping the provider
 * alongside its model knobs lets a root run snapshot its choice once and lets a
 * child deliberately choose a different provider without consulting global
 * settings mid-run. */
export type AgentSelection = Readonly<{ provider: string } & ModelSelection>

/** Optional model-choice fields accepted when spawning a child. Omitted fields
 * inherit from the caller (or, when changing providers, that provider's saved
 * selection). */
export interface AgentSelectionOverride {
  provider?: string
  model?: string
  effort?: Effort
  speed?: Speed
}

interface ProviderBase {
  id: string
  label: string
  /** Billing route used by automatic workflow routing. Free models may override a metered provider. */
  billing: "subscription" | "metered" | "unknown"
  /** True once this provider has usable credentials (API key present / logged in). */
  ready: () => boolean
  /** The models this provider can serve, enriched with capability metadata. */
  listModels: () => Promise<ModelInfo[]>
  /**
   * Preflight the credentials before a run: refresh an expiring OAuth token, or
   * throw if it can't (revoked / no refresh token). Called synchronously at the
   * start of a turn so an unusable token surfaces a clean "run /login" error
   * instead of hanging inside the streaming request. No-op for API-key providers.
   */
  ensureAuth?: () => Promise<void>
  /** Initiate a login flow (OAuth providers only). Optional method: "device" | "browser". */
  login?: (method?: string) => Promise<LoginInitiation>
}

/** LangChain providers build a chat model; alternate providers own the whole
 * agent loop and cannot accidentally be resolved as a chat model. */
export type ProviderDef = ProviderBase &
  (
    | {
        runtime?: "langchain"
        buildModel: (selection: ModelSelection) => BaseChatModel
      }
    | {
        runtime: "anthropic-sdk"
        buildModel?: never
      }
  )

function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Missing required env var ${name}`)
  return v
}

// ---- Zen (inline provider: OpenAI-compatible, API key from .env) ----

/** Zen's live model list from its OpenAI-shaped /models endpoint, enriched with
 *  models.dev metadata (its ids live under the "opencode" provider there). */
async function listZenModels(): Promise<ModelInfo[]> {
  // Zen is optional; discovery must not fail for users who did not configure it.
  if (!zenConfigured()) return []
  const base = requireEnv("ZEN_BASE_URL") // already ends in /v1
  const res = await fetch(`${base}/models`, {
    headers: { Authorization: `Bearer ${requireEnv("ZEN_API_KEY")}` },
  })
  if (!res.ok) throw new Error(`Zen /models returned ${res.status}`)
  const body = (await res.json()) as { data?: Array<{ id?: string }> }
  const ids = (body.data ?? []).map((m) => m.id).filter((id): id is string => Boolean(id))
  return enrichModels(ids, ["opencode"])
}

function zenConfigured(): boolean {
  return Boolean(process.env.ZEN_API_KEY && process.env.ZEN_BASE_URL)
}

function zenReady(): boolean {
  return zenConfigured() && Boolean(selectionFor("zen").model || process.env.ZEN_MODEL)
}

function customProvider(def: CustomProvider): ProviderDef {
  const base = def.baseURL.replace(/\/$/, "")
  return {
    id: def.id,
    label: def.label,
    billing: def.billing ?? "metered",
    ready: () => Boolean(AuthStore.getApiKey(def.id)),
    listModels: async () => {
      const key = AuthStore.getApiKey(def.id)
      if (!key) return def.defaultModel ? enrichModels([def.defaultModel], []) : []
      try {
        const response = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${key}` } })
        if (!response.ok) throw new Error(`models returned ${response.status}`)
        const body = (await response.json()) as { data?: Array<{ id?: string }> }
        const ids = (body.data ?? []).map((m) => m.id).filter((id): id is string => Boolean(id))
        return enrichModels(ids.length ? ids : (def.defaultModel ? [def.defaultModel] : []), [])
      } catch {
        return def.defaultModel ? enrichModels([def.defaultModel], []) : []
      }
    },
    buildModel: (selection) => new ChatOpenAI({
      model: selection.model || def.defaultModel || (() => { throw new Error(`No model configured for ${def.id}`) })(),
      apiKey: keyOrThrow(def.id),
      configuration: { baseURL: base },
      streaming: true,
      ...chatOptionsFor(selection),
    }),
  }
}

function keyOrThrow(id: string): string {
  const key = AuthStore.getApiKey(id)
  if (!key) throw new Error(`Missing API key for ${id}`)
  return key
}

const providers: Record<string, ProviderDef> = {
  zen: {
    id: "zen",
    label: "Zen · OpenAI-compatible (API key)",
    billing: "metered",
    ready: zenReady,
    listModels: listZenModels,
    buildModel: (selection) =>
      new ChatOpenAI({
        model: selection.model || requireEnv("ZEN_MODEL"),
        apiKey: requireEnv("ZEN_API_KEY"),
        configuration: { baseURL: requireEnv("ZEN_BASE_URL") },
        streaming: true,
        ...chatOptionsFor(selection),
      }),
  },
}

/** Register (or replace) a provider. OAuth providers call this at startup. */
export function registerProvider(def: ProviderDef): void {
  providers[def.id] = def
}

export function listProviders(sessionId: string | null = null): ProviderDef[] {
  ensureCustomProviders()
  return Object.values(providers).filter((p) => {
    if (providerScope(p.id) === "incognito" && (!sessionId || !isIncognitoSession(sessionId))) return false
    if (sessionId && isIncognitoSession(sessionId)) return incognitoAllowlistFor(sessionId)?.includes(p.id) ?? false
    return true
  })
}

/** Look up a single provider by id (undefined if unregistered). */
export function getProvider(id: string): ProviderDef | undefined {
  ensureCustomProviders()
  return providers[id]
}

export function mergeModelCatalog(
  advertised: ModelInfo[],
  customModels: ModelInfo[],
  overlay: ReturnType<typeof modelCatalogFor>,
): ModelInfo[] {
  const hidden = new Set(overlay.hidden ?? [])
  const byId = new Map(advertised.map((model) => [model.id, model]))
  for (const model of customModels) {
    if (byId.has(model.id)) continue
    const record = overlay.added?.[model.id]
    byId.set(model.id, { ...model, custom: true, verified: record?.verified ?? false })
  }
  return [...byId.values()].filter((model) => !hidden.has(model.id))
}

/** List the models a provider can serve (throws if the provider is unknown). */
export async function listModelsFor(id: string, sessionId: string | null = null): Promise<ModelInfo[]> {
  assertSelectionAllowed(sessionId, { provider: id })
  const all = await listAllKnownModelsFor(id)
  const hidden = new Set(modelCatalogFor(id).hidden ?? [])
  return all.filter((model) => !hidden.has(model.id))
}

/** Complete catalog for configuration UIs, including currently hidden ids. */
export async function listAllKnownModelsFor(id: string): Promise<ModelInfo[]> {
  ensureCustomProviders()
  const p = providers[id]
  if (!p) throw new Error(`unknown provider "${id}"`)
  const advertised = await p.listModels()
  const overlay = modelCatalogFor(id)
  const advertisedIds = new Set(advertised.map((model) => model.id))
  const customIds = Object.keys(overlay.added ?? {}).filter((model) => !advertisedIds.has(model))
  const custom = customIds.length ? await enrichModels(customIds, []) : []
  return mergeModelCatalog(advertised, custom, { ...overlay, hidden: [] })
}

// ---- Active provider + per-provider selection (persisted) ----

// Runtime override for the active provider. Falls back to the persisted value,
// then CHUNKY_PROVIDER, then "zen". Setting it also persists so it survives restart.
let activeOverride: string | undefined

/** The currently selected provider id. */
export function activeProviderId(): string {
  ensureCustomProviders()
  if (activeOverride && providers[activeOverride]) return activeOverride
  // An explicit persisted choice, including Zen, is always preserved.
  const persisted = persistedProvider()
  if (persisted && providers[persisted]) return persisted
  const requested = process.env.CHUNKY_PROVIDER
  if (requested && providers[requested]) return requested
  // Prefer a ready subscription provider. With no credentials, Anthropic is
  // the deterministic supported auth flow rather than raw ZEN_* errors.
  const readySubscription = Object.values(providers).find(
    (provider) => provider.id !== "zen" && provider.billing === "subscription" && provider.ready(),
  )
  if (readySubscription) return readySubscription.id
  return providers.anthropic ? "anthropic" : Object.keys(providers).find((id) => id !== "zen") ?? "anthropic"
}

/** Select the active provider for subsequently-built models (persisted). */
export function setActiveProviderId(id: string): void {
  ensureCustomProviders()
  if (!providers[id]) throw new Error(`unknown provider "${id}"`)
  activeOverride = id
  setPersistedProvider(id)
}

/** The persisted selection (model + knobs) for a provider. */
export function selectionOf(id: string = activeProviderId()): ModelSelection {
  return selectionFor(id)
}

/** Persist a model + option selection for a provider. */
export function setSelection(id: string, sel: ModelSelection): void {
  ensureCustomProviders()
  if (!providers[id]) throw new Error(`unknown provider "${id}"`)
  setSelectionFor(id, sel)
}

/** Return a frozen, complete selection for a provider's saved model knobs. */
export function selectionForProvider(id: string): AgentSelection {
  ensureCustomProviders()
  if (!providers[id]) throw new Error(`unknown provider "${id}"`)
  return Object.freeze({ provider: id, ...selectionFor(id) })
}

/** Snapshot the active provider and its selection for one agent run. */
export function activeSelection(): AgentSelection {
  return selectionForProvider(activeProviderId())
}

/**
 * Resolve a child selection without looking at the global active provider. A
 * same-provider override inherits its caller's knobs; changing provider starts
 * from that provider's saved selection before applying explicit fields.
 */
export function childSelection(
  parent: AgentSelection,
  override: AgentSelectionOverride | undefined,
): AgentSelection {
  if (!override) return parent

  const provider = override.provider ?? parent.provider
  const base = provider === parent.provider ? parent : selectionForProvider(provider)
  return Object.freeze({
    provider,
    model: override.model ?? base.model,
    effort: override.effort ?? base.effort,
    speed: override.speed ?? base.speed,
  })
}

/**
 * A stable signature of the current active selection. The agent cache keys on
 * this so changing provider OR model OR effort/speed rebuilds the agent, while
 * an unchanged selection reuses it (preserving its live thread state).
 */
export function selectionSignature(selection: AgentSelection = activeSelection()): string {
  return `${selection.provider}::${selection.model ?? ""}::${selection.effort ?? ""}::${selection.speed ?? ""}`
}

/** Build a chat model for one explicit agent selection. */
export function resolveModel(selection: AgentSelection = activeSelection(), sessionId?: string): BaseChatModel {
  assertSelectionAllowed(sessionId ?? null, selection)
  ensureCustomProviders()
  const p = providers[selection.provider]
  if (!p) throw new Error(`unknown provider "${selection.provider}"`)
  if (p.runtime === "anthropic-sdk") {
    throw new Error(`provider "${selection.provider}" uses the ${p.runtime} agent runtime`)
  }
  const { provider: _provider, ...modelSelection } = selection
  return p.buildModel(modelSelection)
}

export function providerRuntime(id: string): NonNullable<ProviderDef["runtime"]> {
  const provider = providers[id]
  if (!provider) throw new Error(`unknown provider "${id}"`)
  return provider.runtime ?? "langchain"
}

// ---- Advisor selection (the always-on side-thread model) ----

/** Resolve the configured advisor selection, or null when it can't run: disabled,
 *  no provider/model chosen, or the provider isn't registered. */
export function resolveAdvisorSelection(): AgentSelection | null {
  const cfg = getAdvisor()
  if (!cfg.enabled || !cfg.provider || !cfg.model || !providers[cfg.provider]) return null
  return Object.freeze({ provider: cfg.provider, model: cfg.model, effort: cfg.effort, speed: undefined })
}

/** The advisor to bind for an `executor`, with the auto-suppress rule: no advisor
 *  when unconfigured, or when it's the SAME model as the executor (advising with
 *  the same model buys nothing). */
export function advisorFor(executor: AgentSelection): AgentSelection | null {
  const advisor = resolveAdvisorSelection()
  if (!advisor) return null
  if (advisor.provider === executor.provider && advisor.model === executor.model) return null
  return advisor
}

/** Effective reviewer model after applying the active mode's tri-state override. */
export function resolveReviewSelection(sessionId?: string): AgentSelection | null {
  const cfg = getEffectiveReview()
  if (!cfg.enabled || !cfg.provider || !cfg.model || !providers[cfg.provider]) return null
  const selection = Object.freeze({ provider: cfg.provider, model: cfg.model, effort: cfg.effort, speed: undefined })
  try { assertSelectionAllowed(sessionId ?? null, selection) } catch { return null }
  return selection
}

// ---- Sidekick selection (the persistent worker side-thread model) ----

/** Resolve the sidekick seat for one lead `executor`, or null when disabled.
 *  Unlike the advisor there is NO same-model auto-suppress and NO unconfigured
 *  suppress: a sidekick on the lead's own model still buys context isolation
 *  (the hands-on loop stays out of the lead's context), so an unconfigured seat
 *  falls back to the executor's selection. Configure the seat (e.g. a cheaper
 *  model at higher effort) to also buy the cost win. */
export function sidekickFor(executor: AgentSelection): AgentSelection | null {
  const cfg = getSidekick()
  if (!cfg.enabled) return null
  if (!cfg.provider || !cfg.model || !providers[cfg.provider]) {
    return Object.freeze({ provider: executor.provider, model: executor.model, effort: executor.effort, speed: executor.speed })
  }
  return Object.freeze({ provider: cfg.provider, model: cfg.model, effort: cfg.effort, speed: undefined })
}

/** Configured NAMED seat names (e.g. ["backend", "frontend"]), sorted. Empty
 *  when none are configured or the master switch is off. */
export function listSidekickSeats(): string[] {
  if (!getSidekick().enabled) return []
  return Object.keys(getSidekickSeats())
    .filter((name) => {
      const seat = getSidekickSeats()[name]
      return seat && providers[seat.provider] != null
    })
    .sort()
}

/** Resolve one NAMED seat to a selection, or null when it doesn't exist (or its
 *  provider isn't registered, or the master switch is off). The DEFAULT seat is
 *  resolved by sidekickFor, not here. */
export function resolveSidekickSeat(name: string): AgentSelection | null {
  if (!getSidekick().enabled) return null
  const seat = getSidekickSeats()[name]
  if (!seat || !providers[seat.provider]) return null
  return Object.freeze({ provider: seat.provider, model: seat.model, effort: seat.effort, speed: undefined })
}

// OAuth providers self-register on import. Kept at the bottom so the registry's
// functions/types above are fully initialized before these modules load them.
// (grok/codex import only *types* from this file, so the cycle is erased at runtime.)
import { grokProvider } from "./grok.ts"
import { codexProvider } from "./codex.ts"
import { anthropicProvider } from "./anthropic-sdk.ts"
registerProvider(grokProvider)
registerProvider(codexProvider)
registerProvider(anthropicProvider)

// Settings are deliberately consulted on first use, not while this module is
// being evaluated. Tests (and embedders) commonly select CHUNKY_SETTINGS after
// importing the registry, and settings are user-editable between requests.
const BUILT_INS = new Set(["zen", "codex", "grok", "anthropic"])
let loadedCustomSignature = ""
function ensureCustomProviders(): void {
  const custom = loadSettings().customProviders ?? []
  const signature = JSON.stringify(custom)
  if (signature === loadedCustomSignature) return
  loadedCustomSignature = signature
  for (const id of Object.keys(providers)) if (!BUILT_INS.has(id)) delete providers[id]
  for (const def of custom) {
    if (!def?.id || BUILT_INS.has(def.id)) {
      console.warn(`[@chunky/server] skipping custom provider with colliding id: ${def?.id ?? "(missing)"}`)
      continue
    }
    registerProvider(customProvider(def))
  }
}
