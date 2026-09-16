import { ChatOpenAICompletions } from "@langchain/openai"
import { AuthStore } from "./auth-store.ts"
import { chatOptionsFor } from "./model-options.ts"
import type { ModelInfo, ProviderDef } from "./registry.ts"

export const TELNYX_BASE_URL = "https://api.telnyx.com/v2/ai/openai"

function apiKey(): string | undefined {
  return AuthStore.getApiKey("telnyx")?.trim() || process.env.TELNYX_API_KEY?.trim()
}

function requireKey(): string {
  const key = apiKey()
  if (!key) throw new Error("Add your Telnyx API key in /onboard or set TELNYX_API_KEY.")
  return key
}

/** Use the account's live catalog, not a snapshot of the documentation page. */
export async function fetchTelnyxModels(key: string): Promise<ModelInfo[]> {
  const response = await fetch(`${TELNYX_BASE_URL}/models`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new Error("Telnyx rejected the API key. Check the key and account permissions.")
    throw new Error(`Telnyx model discovery failed (HTTP ${response.status}). Try again.`)
  }
  const body = await response.json() as { data?: unknown }
  if (!Array.isArray(body.data)) throw new Error("Telnyx returned an invalid model catalog.")
  const models = new Map<string, ModelInfo>()
  for (const entry of body.data) {
    if (!entry || typeof entry.id !== "string" || !entry.id.trim()) continue
    // Older OpenAI-shaped catalogs omit task; an explicit non-chat task is excluded.
    if (entry.task && entry.task !== "text-generation") continue
    models.set(entry.id, {
      id: entry.id,
      name: entry.id,
      // The catalog does not advertise supported effort values. Let the model
      // use its default rather than offer unsupported reasoning settings.
      reasoning: false,
      ...(typeof entry.context_length === "number" && entry.context_length > 0
        ? { contextLimit: entry.context_length } : {}),
    })
  }
  return [...models.values()]
}

export const telnyxProvider: ProviderDef = {
  id: "telnyx",
  label: "Telnyx · Inference (API key)",
  billing: "metered",
  ready: () => Boolean(apiKey()),
  ensureAuth: async () => { requireKey() },
  listModels: async () => {
    const key = apiKey()
    return key ? fetchTelnyxModels(key) : []
  },
  buildModel: (selection) => {
    if (!selection.model) throw new Error("Choose a Telnyx model with /model.")
    return new ChatOpenAICompletions({
      model: selection.model,
      apiKey: requireKey(),
      configuration: { baseURL: TELNYX_BASE_URL },
      streaming: true,
      ...chatOptionsFor(selection),
    })
  },
}
