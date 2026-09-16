import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { AuthStore } from "./auth-store.ts"
import { goFetch, goTransport, OPENCODE_GO_BASE_URL, opencodeGoProvider } from "./opencode-go.ts"
import { getProvider, listProviders, resolveModel } from "./registry.ts"
import { saveCustomProviders } from "../settings.ts"
import { CHUNKY_USER_AGENT } from "./app-info.ts"

let root: string
let originalFetch: typeof fetch
let previous: Record<string, string | undefined>
beforeEach(() => {
  previous = Object.fromEntries(["CHUNKY_AUTH", "CHUNKY_SETTINGS", "OPENCODE_GO_API_KEY", "ZEN_API_KEY", "OPENCODE_API_KEY"].map((key) => [key, process.env[key]]))
  originalFetch = globalThis.fetch
  root = mkdtempSync(join(tmpdir(), "chunky-go-"))
  process.env.CHUNKY_AUTH = join(root, "auth.json")
  process.env.CHUNKY_SETTINGS = join(root, "settings.json")
  delete process.env.OPENCODE_GO_API_KEY
})
afterEach(() => {
  globalThis.fetch = originalFetch
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(root, { recursive: true, force: true })
})

test("Go is a reserved subscription provider with credentials isolated from Zen", async () => {
  expect(listProviders().find((p) => p.id === "opencode-go")).toBeDefined()
  saveCustomProviders([{ id: "opencode-go", label: "Imposter", baseURL: "https://example.invalid" }])
  expect(getProvider("opencode-go")).toBe(opencodeGoProvider)
  expect(opencodeGoProvider.billing).toBe("subscription")
  AuthStore.set("zen", { type: "api", key: "zen-key" })
  process.env.ZEN_API_KEY = "zen-env"
  process.env.OPENCODE_API_KEY = "shared-env"
  expect(opencodeGoProvider.ready()).toBe(false)
  expect(await opencodeGoProvider.listModels()).toEqual([])
  await expect(opencodeGoProvider.ensureAuth!()).rejects.toThrow("OPENCODE_GO_API_KEY")
  process.env.OPENCODE_GO_API_KEY = "go-env"
  expect(opencodeGoProvider.ready()).toBe(true)
})

test("Go catalog is fresh, authenticated with its own saved key, and validates its shape", async () => {
  AuthStore.set("opencode-go", { type: "api", key: "saved-go-key" })
  process.env.OPENCODE_GO_API_KEY = "env-key"
  let calls = 0
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init)
    expect(request.url).toBe(`${OPENCODE_GO_BASE_URL}/models`)
    expect(request.headers.get("authorization")).toBe("Bearer saved-go-key")
    expect(request.headers.get("user-agent")).toBe(CHUNKY_USER_AGENT)
    expect(request.headers.get("x-opencode-session")).toBeTruthy()
    expect(init?.signal).toBeDefined()
    return Response.json({ data: [{ id: `glm-${++calls}` }, { id: "" }, null] })
  }) as typeof fetch
  expect((await opencodeGoProvider.listModels())[0]?.id).toBe("glm-1")
  expect((await opencodeGoProvider.listModels())[0]?.id).toBe("glm-2")
  globalThis.fetch = (async () => Response.json({ wrong: [] })) as unknown as typeof fetch
  await expect(opencodeGoProvider.listModels()).rejects.toThrow("invalid model catalog")
  globalThis.fetch = (async () => new Response("upstream secret", { status: 500 })) as unknown as typeof fetch
  await expect(opencodeGoProvider.listModels()).rejects.toThrow("HTTP 500")
})

test.each([
  ["minimax-m3", "messages"], ["qwen3.8-max", "messages"],
  ["gpt-5.6-luna", "responses"], ["grok-4.6", "responses"], ["muse-spark-1.3-contributor", "responses"],
  ["glm-5.3", "chat"], ["kimi-k3", "chat"], ["deepseek-v4-pro", "chat"],
] as const)("routes %s through %s", (model, transport) => { expect(goTransport(model!)).toBe(transport) })

function streamResponse(transport: string): Response {
  let events: object[]
  if (transport === "messages") {
    events = [
      { type: "message_start", message: { id: "msg_test", type: "message", role: "assistant", model: "minimax-m3", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ]
  } else if (transport === "responses") {
    events = [
      { type: "response.created", response: { id: "resp_test", object: "response", status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: { id: "msg_test", type: "message", role: "assistant", content: [] } },
      { type: "response.output_text.delta", item_id: "msg_test", output_index: 0, content_index: 0, delta: "OK" },
      { type: "response.completed", response: { id: "resp_test", object: "response", status: "completed", output: [{ id: "msg_test", type: "message", role: "assistant", content: [{ type: "output_text", text: "OK", annotations: [] }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ]
  } else {
    events = [
      { id: "test", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null }] },
      { id: "test", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
    ]
  }
  const text = events.map((event) => `${"type" in event ? `event: ${event.type}\n` : ""}data: ${JSON.stringify(event)}\n\n`).join("")
  return new Response(text + (transport === "chat" ? "data: [DONE]\n\n" : ""), { headers: { "content-type": "text/event-stream" } })
}

test.each([
  ["glm-5.3", "chat", "chat/completions"],
  ["grok-4.6", "responses", "responses"],
  ["minimax-m3", "messages", "messages"],
])("real SDK for %s sends Go auth, tools and stable conversation headers", async (modelId, transport, path) => {
  AuthStore.set("opencode-go", { type: "api", key: "go-key" })
  AuthStore.set("zen", { type: "api", key: "zen-key" })
  const sessions: string[] = []
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init)
    expect(request.url).toBe(`${OPENCODE_GO_BASE_URL}/${path}`)
    expect(request.headers.get("authorization")).toBe("Bearer go-key")
    expect(request.headers.get("user-agent")).toBe(CHUNKY_USER_AGENT)
    expect(request.headers.get("x-opencode-client")).toBe("chunky")
    sessions.push(request.headers.get("x-opencode-session")!)
    const body = await request.json() as any
    expect(body.model).toBe(modelId)
    expect(body.stream).toBe(true)
    expect(body.tools[0].name ?? body.tools[0].function?.name).toBe("lookup")
    return streamResponse(transport!)
  }) as typeof fetch
  const selection = { provider: "opencode-go", model: modelId! }
  const a = resolveModel(selection, "conversation-a")
  const b = resolveModel(selection, "conversation-a") // auxiliary/rebuilt model
  const c = resolveModel(selection, "conversation-b")
  const fallback = resolveModel(selection)
  for (const model of [a, a, b, c, fallback, fallback]) {
    const stream = await model.stream("hello", { tools: [{ type: "function", function: { name: "lookup", description: "Lookup", parameters: { type: "object", properties: {} } } }] } as any)
    let content = ""
    for await (const chunk of stream) content += chunk.text
    expect(content).toBe("OK")
  }
  expect(sessions.slice(0, 4)).toEqual(["conversation-a", "conversation-a", "conversation-a", "conversation-b"])
  expect(sessions[4]).toBeTruthy()
  expect(sessions[4]).toBe(sessions[5])
  expect(sessions[4]).not.toBe("conversation-a")
  expect(AuthStore.getApiKey("zen")).toBe("zen-key")
})

test("Go required headers win over SDK and request overrides without dropping other headers", async () => {
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init)
    expect(request.headers.get("x-opencode-session")).toBe("correct-session")
    expect(request.headers.get("authorization")).toBe("Bearer correct-key")
    expect(request.headers.get("user-agent")).toBe(CHUNKY_USER_AGENT)
    expect(request.headers.get("anthropic-version")).toBe("2023-06-01")
    expect(request.headers.get("content-type")).toBe("application/json")
    return new Response("ok")
  }) as typeof fetch
  await goFetch("correct-session", "correct-key")(new Request(`${OPENCODE_GO_BASE_URL}/messages`, { headers: { "anthropic-version": "2023-06-01", "x-opencode-session": "wrong" } }), {
    headers: { "content-type": "application/json", "authorization": "Bearer wrong-key", "user-agent": "generic-sdk", "x-opencode-session": "also-wrong" },
  })
})
