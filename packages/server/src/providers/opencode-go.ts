import { ChatAnthropic } from "@langchain/anthropic"
import { ChatOpenAICompletions, ChatOpenAIResponses } from "@langchain/openai"
import { AuthStore } from "./auth-store.ts"
import { CHUNKY_USER_AGENT } from "./app-info.ts"
import type { ModelInfo, ProviderDef } from "./registry.ts"

export const OPENCODE_GO_BASE_URL = "https://opencode.ai/zen/go/v1"

function apiKey(): string | undefined {
  return AuthStore.getApiKey("opencode-go")?.trim() || process.env.OPENCODE_GO_API_KEY?.trim()
}

function requireKey(): string {
  const key = apiKey()
  if (!key) throw new Error("Add your OpenCode Go API key in /onboard or set OPENCODE_GO_API_KEY.")
  return key
}

/** Apply these last: SDK defaults and call-level headers must not replace them. */
export function goFetch(sessionId: string, key: string): typeof fetch {
  return ((input, init) => {
    const headers = new Headers(input instanceof Request ? input.headers : undefined)
    new Headers(init?.headers).forEach((value, name) => headers.set(name, value))
    headers.set("x-opencode-session", sessionId)
    headers.set("x-opencode-client", "chunky")
    headers.set("user-agent", CHUNKY_USER_AGENT)
    headers.set("authorization", `Bearer ${key}`)
    return fetch(input, { ...init, headers })
  }) as typeof fetch
}

// Go's catalog gives IDs, not transport types. Keep the routing in sync with
// https://opencode.ai/docs/go/#endpoints; Go is distinct from the Zen endpoint.
export function goTransport(model: string): "messages" | "responses" | "chat" {
  if (/^(minimax-|qwen)/i.test(model)) return "messages"
  if (/^(grok-|gpt-|muse-spark-)/i.test(model)) return "responses"
  return "chat"
}

export const opencodeGoProvider: ProviderDef = {
  id: "opencode-go",
  label: "OpenCode Go · Subscription (API key)",
  billing: "subscription",
  ready: () => Boolean(apiKey()),
  ensureAuth: async () => { requireKey() },
  listModels: async () => {
    const key = apiKey()
    if (!key) return []
    // This endpoint is public: fetching it does not validate account access.
    const response = await goFetch("chunky-model-catalog", key)(`${OPENCODE_GO_BASE_URL}/models`, {
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error(`OpenCode Go model discovery failed (HTTP ${response.status}). Try again.`)
    const body = await response.json() as { data?: unknown }
    if (!Array.isArray(body.data)) throw new Error("OpenCode Go returned an invalid model catalog.")
    const models = new Map<string, ModelInfo>()
    for (const entry of body.data) {
      if (!entry || typeof entry.id !== "string" || !entry.id.trim()) continue
      // Effort values differ across Go models; retain each model's defaults.
      models.set(entry.id, { id: entry.id, name: entry.id, reasoning: false })
    }
    return [...models.values()]
  },
  buildModel: (selection, sessionId) => {
    if (!selection.model) throw new Error("Choose an OpenCode Go model with /model.")
    const key = requireKey()
    // Auxiliary calls use the same conversation ID. Standalone callers get a
    // stable ID for this model instance, including subsequent calls and retries.
    const fetch = goFetch(sessionId || crypto.randomUUID(), key)
    const common = { model: selection.model, apiKey: key, streaming: true }
    if (goTransport(selection.model) === "messages") {
      return new ChatAnthropic({
        ...common,
        // The SDK defaults unknown model names to only 4K output tokens.
        maxTokens: 16384,
        anthropicApiUrl: OPENCODE_GO_BASE_URL.slice(0, -3),
        clientOptions: { fetch },
      })
    }
    const configuration = { baseURL: OPENCODE_GO_BASE_URL, fetch }
    return goTransport(selection.model) === "responses"
      ? new ChatOpenAIResponses({ ...common, configuration })
      : new ChatOpenAICompletions({ ...common, configuration })
  },
}
