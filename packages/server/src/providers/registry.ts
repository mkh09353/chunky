// Provider registry — the seam OAuth providers plug into.
//
// Today it holds one entry: Zen (GLM-5.2, OpenAI-compatible, API key from .env).
// OAuth providers (Codex / Grok / Claude) register here: each owns its own login
// + token injection and returns a ready `BaseChatModel` from buildModel(). The
// rest of the app only ever calls resolveModel()/listProviders() — it never sees
// how a provider authenticates.
import type { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { ChatOpenAI } from "@langchain/openai"

export interface ProviderDef {
  id: string
  label: string
  /** True once this provider has usable credentials (API key present / logged in). */
  ready: () => boolean
  /** Build a ready-to-use chat model with auth/token injection already applied. */
  buildModel: () => BaseChatModel
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

/** The currently selected provider id (MC_PROVIDER env, default "zen"). */
export function activeProviderId(): string {
  return process.env.MC_PROVIDER || "zen"
}

/** Build the chat model for the active (or named) provider. */
export function resolveModel(id: string = activeProviderId()): BaseChatModel {
  const p = providers[id]
  if (!p) throw new Error(`unknown provider "${id}"`)
  return p.buildModel()
}
