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
import { enrichModels, type ModelInfo } from "./models-catalog.ts"
import { chatOptionsFor } from "./model-options.ts"
import {
  persistedProvider,
  selectionFor,
  setPersistedProvider,
  setSelectionFor,
  type ModelSelection,
} from "../settings.ts"

export type { ModelInfo } from "./models-catalog.ts"
export type { Effort, ModelSelection, Speed } from "../settings.ts"

/** What a provider returns when a login flow is initiated. The actual token
 *  exchange completes in the background; poll `ready()` / the status route. */
export interface LoginInitiation {
  /** URL the user opens (device verification page, or a browser authorize URL). */
  url: string
  /** Short device code to type on the verification page (device-code flow only). */
  userCode?: string
  /** Human-readable next step. */
  instructions: string
}

export interface ProviderDef {
  id: string
  label: string
  /** True once this provider has usable credentials (API key present / logged in). */
  ready: () => boolean
  /** The models this provider can serve, enriched with capability metadata. */
  listModels: () => Promise<ModelInfo[]>
  /** Build a ready-to-use chat model for the given selection (model id + knobs),
   *  with auth/token injection already applied. */
  buildModel: (selection: ModelSelection) => BaseChatModel
  /** Initiate a login flow (OAuth providers only). Optional method: "device" | "browser". */
  login?: (method?: string) => Promise<LoginInitiation>
}

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

/** List the models a provider can serve (throws if the provider is unknown). */
export function listModelsFor(id: string): Promise<ModelInfo[]> {
  const p = providers[id]
  if (!p) throw new Error(`unknown provider "${id}"`)
  return p.listModels()
}

// ---- Active provider + per-provider selection (persisted) ----

// Runtime override for the active provider. Falls back to the persisted value,
// then MC_PROVIDER, then "zen". Setting it also persists so it survives restart.
let activeOverride: string | undefined

/** The currently selected provider id. */
export function activeProviderId(): string {
  return activeOverride || persistedProvider() || process.env.MC_PROVIDER || "zen"
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

/**
 * A stable signature of the current active selection. The agent cache keys on
 * this so changing provider OR model OR effort/speed rebuilds the agent, while
 * an unchanged selection reuses it (preserving its live thread state).
 */
export function selectionSignature(): string {
  const id = activeProviderId()
  const s = selectionFor(id)
  return `${id}::${s.model ?? ""}::${s.effort ?? ""}::${s.speed ?? ""}`
}

/** Build the chat model for the active (or named) provider using its selection. */
export function resolveModel(id: string = activeProviderId()): BaseChatModel {
  const p = providers[id]
  if (!p) throw new Error(`unknown provider "${id}"`)
  return p.buildModel(selectionFor(id))
}

// OAuth providers self-register on import. Kept at the bottom so the registry's
// functions/types above are fully initialized before these modules load them.
// (grok/codex import only *types* from this file, so the cycle is erased at runtime.)
import { grokProvider } from "./grok.ts"
import { codexProvider } from "./codex.ts"
registerProvider(grokProvider)
registerProvider(codexProvider)
