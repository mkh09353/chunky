import { tool } from "@langchain/core/tools"
import { z } from "zod"
import { activeProviderId, getProvider, listProviders } from "../providers/registry.ts"
import { AuthStore } from "../providers/auth-store.ts"
import { loadSettings, saveCustomProviders } from "../settings.ts"

const RESERVED = new Set(["zen", "codex", "grok", "anthropic"])

export const manageProvidersInputShape = {
  action: z.enum(["add", "list", "remove", "test"]),
  id: z.string().optional().describe("Provider id. Required for add, remove, and test."),
  label: z.string().optional().describe("Display label. Required for add."),
  baseURL: z.string().optional().describe("OpenAI-compatible http(s) API base URL. Required for add."),
  defaultModel: z.string().optional().describe("Optional default model id for the provider."),
  billing: z.enum(["subscription", "metered"]).optional(),
}

function required(value: string | undefined, name: string): string {
  const normalized = value?.trim()
  if (!normalized) throw new Error(`${name} is required`)
  return normalized
}

function assertCustomId(id: string): void {
  if (RESERVED.has(id)) throw new Error(`provider id "${id}" is reserved`)
}

export async function manageProviders(
  action: "add" | "list" | "remove" | "test",
  input: { id?: string; label?: string; baseURL?: string; defaultModel?: string; billing?: "subscription" | "metered" } = {},
): Promise<unknown> {
  if (action === "list") {
    const custom = new Set((loadSettings().customProviders ?? []).map((provider) => provider.id))
    const active = activeProviderId()
    return { providers: listProviders().map((provider) => ({
      id: provider.id,
      label: provider.label,
      ready: provider.ready(),
      active: provider.id === active,
      custom: custom.has(provider.id),
    })) }
  }

  const id = required(input.id, "id")
  if (action === "add") {
    assertCustomId(id)
    const label = required(input.label, "label")
    const baseURL = required(input.baseURL, "baseURL")
    let parsed: URL
    try { parsed = new URL(baseURL) } catch { throw new Error("baseURL must be a valid http(s) URL") }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("baseURL must use http or https")
    const provider = { id, label, baseURL, defaultModel: input.defaultModel, billing: input.billing }
    saveCustomProviders([...(loadSettings().customProviders ?? []).filter((item) => item.id !== id), provider])
    return { id, label, ready: getProvider(id)?.ready() ?? false }
  }

  if (action === "remove") {
    assertCustomId(id)
    const custom = loadSettings().customProviders ?? []
    if (!custom.some((provider) => provider.id === id)) throw new Error(`custom provider "${id}" is not registered`)
    saveCustomProviders(custom.filter((provider) => provider.id !== id))
    AuthStore.remove(id)
    return { removed: id }
  }

  const provider = getProvider(id)
  if (!provider) throw new Error(`unknown provider "${id}"`)
  try {
    if (provider.ensureAuth) await provider.ensureAuth()
    if (!provider.ready()) throw new Error(`provider "${id}" is not ready`)
    return { id, ok: true }
  } catch (error) {
    return { id, ok: false, error: (error as Error)?.message ?? String(error) }
  }
}

export const manageProvidersTool = tool(
  async ({ action, id, label, baseURL, defaultModel, billing }) =>
    JSON.stringify(await manageProviders(action, { id, label, baseURL, defaultModel, billing }), null, 2),
  {
    name: "manage_providers",
    description: "Manage model providers only when the user asks to add or set up a provider. Add stores metadata only; API keys must never pass through this tool. List readiness, remove custom providers, or test configured authentication.",
    schema: z.object(manageProvidersInputShape),
  },
)
