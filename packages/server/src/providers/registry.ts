// Provider registry — the seam OAuth providers plug into.
//
// Today it holds one entry: Zen (GLM-5.2, OpenAI-compatible, API key from .env).
// OAuth providers (Codex / Grok / Claude) register here: each owns its own login
// + token injection and returns a ready `BaseChatModel` from buildModel(). The
// rest of the app only ever calls resolveModel()/listProviders() — it never sees
// how a provider authenticates.
import type { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { ChatOpenAI } from "@langchain/openai"

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
  /** Build a ready-to-use chat model with auth/token injection already applied. */
  buildModel: () => BaseChatModel
  /** Initiate a login flow (OAuth providers only). Optional method: "device" | "browser". */
  login?: (method?: string) => Promise<LoginInitiation>
}

function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Missing required env var ${name}`)
  return v
}

const providers: Record<string, ProviderDef> = {
  zen: {
    id: "zen",
    label: "Zen · GLM-5.2 (API key)",
    ready: () => Boolean(process.env.ZEN_API_KEY),
    buildModel: () =>
      new ChatOpenAI({
        model: requireEnv("ZEN_MODEL"),
        apiKey: requireEnv("ZEN_API_KEY"),
        configuration: { baseURL: requireEnv("ZEN_BASE_URL") },
        streaming: true,
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

// Runtime override for the active provider, set by the /select route. Takes
// precedence over MC_PROVIDER so a user can switch providers without a restart.
let activeOverride: string | undefined

/** The currently selected provider id (runtime override, else MC_PROVIDER env, else "zen"). */
export function activeProviderId(): string {
  return activeOverride || process.env.MC_PROVIDER || "zen"
}

/** Select the active provider for subsequently-built models. */
export function setActiveProviderId(id: string): void {
  if (!providers[id]) throw new Error(`unknown provider "${id}"`)
  activeOverride = id
}

/** Build the chat model for the active (or named) provider. */
export function resolveModel(id: string = activeProviderId()): BaseChatModel {
  const p = providers[id]
  if (!p) throw new Error(`unknown provider "${id}"`)
  return p.buildModel()
}

// OAuth providers self-register on import. Kept at the bottom so the registry's
// functions/types above are fully initialized before these modules load them.
// (grok/codex import only *types* from this file, so the cycle is erased at runtime.)
import { grokProvider } from "./grok.ts"
import { codexProvider } from "./codex.ts"
registerProvider(grokProvider)
registerProvider(codexProvider)
