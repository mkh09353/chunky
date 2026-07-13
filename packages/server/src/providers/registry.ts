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
import {
  getAdvisor,
  persistedProvider,
  selectionFor,
  setPersistedProvider,
  setSelectionFor,
  modelCatalogFor,
  type Effort,
  type ModelSelection,
  type Speed,
} from "../settings.ts"

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
  const base = requireEnv("ZEN_BASE_URL") // already ends in /v1
  const res = await fetch(`${base}/models`, {
    headers: { Authorization: `Bearer ${requireEnv("ZEN_API_KEY")}` },
  })
  if (!res.ok) throw new Error(`Zen /models returned ${res.status}`)
  const body = (await res.json()) as { data?: Array<{ id?: string }> }
  const ids = (body.data ?? []).map((m) => m.id).filter((id): id is string => Boolean(id))
  return enrichModels(ids, ["opencode"])
}

const providers: Record<string, ProviderDef> = {
  zen: {
    id: "zen",
    label: "Zen · OpenAI-compatible (API key)",
    ready: () => Boolean(process.env.ZEN_API_KEY),
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

export function listProviders(): ProviderDef[] {
  return Object.values(providers)
}

/** Look up a single provider by id (undefined if unregistered). */
export function getProvider(id: string): ProviderDef | undefined {
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
export async function listModelsFor(id: string): Promise<ModelInfo[]> {
  const all = await listAllKnownModelsFor(id)
  const hidden = new Set(modelCatalogFor(id).hidden ?? [])
  return all.filter((model) => !hidden.has(model.id))
}

/** Complete catalog for configuration UIs, including currently hidden ids. */
export async function listAllKnownModelsFor(id: string): Promise<ModelInfo[]> {
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
  return activeOverride || persistedProvider() || process.env.CHUNKY_PROVIDER || "zen"
}

/** Select the active provider for subsequently-built models (persisted). */
export function setActiveProviderId(id: string): void {
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
  if (!providers[id]) throw new Error(`unknown provider "${id}"`)
  setSelectionFor(id, sel)
}

/** Return a frozen, complete selection for a provider's saved model knobs. */
export function selectionForProvider(id: string): AgentSelection {
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
export function resolveModel(selection: AgentSelection = activeSelection()): BaseChatModel {
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

// OAuth providers self-register on import. Kept at the bottom so the registry's
// functions/types above are fully initialized before these modules load them.
// (grok/codex import only *types* from this file, so the cycle is erased at runtime.)
import { grokProvider } from "./grok.ts"
import { codexProvider } from "./codex.ts"
import { anthropicProvider } from "./anthropic-sdk.ts"
registerProvider(grokProvider)
registerProvider(codexProvider)
registerProvider(anthropicProvider)
