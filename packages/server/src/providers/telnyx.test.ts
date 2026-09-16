import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { AuthStore } from "./auth-store.ts"
import { fetchTelnyxModels, TELNYX_BASE_URL, telnyxProvider } from "./telnyx.ts"
import { getProvider, listProviders } from "./registry.ts"
import { saveCustomProviders } from "../settings.ts"
import { ChatOpenAICompletions } from "@langchain/openai"

let root: string
let previous: { auth?: string; settings?: string; key?: string }
let originalFetch: typeof fetch
beforeEach(() => {
  previous = { auth: process.env.CHUNKY_AUTH, settings: process.env.CHUNKY_SETTINGS, key: process.env.TELNYX_API_KEY }
  originalFetch = globalThis.fetch
  root = mkdtempSync(join(tmpdir(), "chunky-telnyx-"))
  process.env.CHUNKY_AUTH = join(root, "auth.json")
  process.env.CHUNKY_SETTINGS = join(root, "settings.json")
  delete process.env.TELNYX_API_KEY
})
afterEach(() => {
  globalThis.fetch = originalFetch
  for (const [name, value] of Object.entries({ CHUNKY_AUTH: previous.auth, CHUNKY_SETTINGS: previous.settings, TELNYX_API_KEY: previous.key })) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  rmSync(root, { recursive: true, force: true })
})

test("Telnyx ships without custom settings and cannot be replaced by them", () => {
  expect(listProviders().some((p) => p.id === "telnyx")).toBe(true)
  saveCustomProviders([{ id: "telnyx", label: "Imposter", baseURL: "https://example.invalid" }])
  expect(getProvider("telnyx")).toBe(telnyxProvider)
  expect(telnyxProvider.ready()).toBe(false)
  process.env.TELNYX_API_KEY = "env-key"
  expect(telnyxProvider.ready()).toBe(true)
})

test("catalog is fetched fresh with the saved key, preserving IDs and context and excluding embeddings", async () => {
  process.env.TELNYX_API_KEY = "env-key"
  AuthStore.set("telnyx", { type: "api", key: "saved-key" })
  let calls = 0
  globalThis.fetch = (async (url, init) => {
    expect(String(url)).toBe(`${TELNYX_BASE_URL}/models`)
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer saved-key")
    expect(init?.signal).toBeDefined()
    calls++
    return Response.json({ data: [
      { id: `org/chat-${calls}`, task: "text-generation", context_length: 262144 },
      { id: "org/embedding", task: "feature-extraction" },
      { id: "org/audio", task: "automatic-speech-recognition" },
      { id: "legacy/chat" }, { id: "" }, null,
    ] })
  }) as typeof fetch
  expect(await telnyxProvider.listModels()).toEqual([
    { id: "org/chat-1", name: "org/chat-1", reasoning: false, contextLimit: 262144 },
    { id: "legacy/chat", name: "legacy/chat", reasoning: false },
  ])
  expect((await telnyxProvider.listModels())[0]?.id).toBe("org/chat-2")
})

test("missing credentials skip discovery; rejected keys and malformed catalogs do not become fake models", async () => {
  globalThis.fetch = (async () => { throw new Error("unexpected request") }) as unknown as typeof fetch
  expect(await telnyxProvider.listModels()).toEqual([])
  await expect(telnyxProvider.ensureAuth!()).rejects.toThrow("/onboard")
  globalThis.fetch = (async () => new Response("do not expose upstream body", { status: 401 })) as unknown as typeof fetch
  await expect(fetchTelnyxModels("test")).rejects.toThrow("rejected the API key")
  globalThis.fetch = (async () => Response.json({ wrong: [] })) as unknown as typeof fetch
  await expect(fetchTelnyxModels("test")).rejects.toThrow("invalid model catalog")
})

test("real ChatOpenAI transport sends Telnyx chat completions with its own credentials and tools", async () => {
  AuthStore.set("telnyx", { type: "api", key: "telnyx-test-key" })
  AuthStore.set("other", { type: "api", key: "other-key" })
  let requestBody: Record<string, unknown> | undefined
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init)
    expect(request.url).toBe(`${TELNYX_BASE_URL}/chat/completions`)
    expect(request.headers.get("authorization")).toBe("Bearer telnyx-test-key")
    requestBody = await request.json() as Record<string, unknown>
    return new Response('data: {"id":"test","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"OK"},"finish_reason":null}]}\n\ndata: {"id":"test","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: {"id":"test","object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } })
  }) as typeof fetch
  if (telnyxProvider.runtime === "anthropic-sdk") throw new Error("Wrong runtime")
  const model = telnyxProvider.buildModel({ model: "org/codex-chat", effort: "high" }) as ChatOpenAICompletions
  const stream = await model.stream("hello", { tools: [{ type: "function", function: { name: "lookup", description: "Lookup", parameters: { type: "object", properties: {} } } }] })
  let content = ""
  for await (const chunk of stream) content += chunk.content
  expect(content).toBe("OK")
  expect(requestBody).toMatchObject({ model: "org/codex-chat", stream: true, reasoning_effort: "high", tools: [{ type: "function", function: { name: "lookup" } }] })
  expect(AuthStore.getApiKey("other")).toBe("other-key")
})
