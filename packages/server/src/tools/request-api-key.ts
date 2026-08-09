import { tool } from "@langchain/core/tools"
import { z } from "zod"
import { getAppBrowserEndpoint } from "../app-browser.ts"
import { createKeyRequest } from "../provider-key-requests.ts"
import { getProvider } from "../providers/registry.ts"
import { sessionForThread } from "../thread-context.ts"
import { toolResult } from "./result.ts"

export const requestApiKeyInputShape = {
  providerId: z.string().describe("Provider id whose API key the desktop should request."),
  label: z.string().optional().describe("Optional user-facing provider label override."),
}

export const request_api_key = tool(async ({ providerId, label }: { providerId: string; label?: string }, config?: unknown) => {
  if (!getAppBrowserEndpoint()) return toolResult("The Chunky desktop app isn't running — ask the user to open the app.", { ok: false })
  const sessionId = sessionForThread((config as any)?.configurable?.thread_id)
  if (!sessionId) return toolResult("request_api_key is only available inside an active session run.", { ok: false })
  const provider = getProvider(providerId)
  if (!provider) return toolResult(`Unknown provider "${providerId}". Add it with manage_providers first.`, { ok: false })
  const result = await createKeyRequest(providerId, label?.trim() || provider.label, sessionId)
  if (result === "stored") return toolResult(`The API key for ${provider.label} was stored securely. Use manage_providers with action "test" to verify it.`)
  if (result === "cancelled") return toolResult(`The user cancelled the API key request for ${provider.label}.`, { ok: false })
  return toolResult(`The API key request for ${provider.label} timed out. Ask the user to keep the desktop app open and try again.`, { ok: false })
}, {
  name: "request_api_key",
  description: "Ask the user to enter a model provider API key securely in the Chunky desktop app. The key is never exposed to the agent, tool schema, transcript, or output.",
  schema: z.object(requestApiKeyInputShape),
})
