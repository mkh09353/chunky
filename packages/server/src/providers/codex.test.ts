import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { AuthStore } from "./auth-store.ts"
import { codexProvider, prepareCodexResponsesRequest, swapCodexCompactionHistory, tryImportCodexCliAuth, validAuth } from "./codex.ts"

describe("codex provider", () => {
  test("advertises every current GPT-5.6 Codex model", async () => {
    const ids = (await codexProvider.listModels()).map((model) => model.id)

    expect(ids).toEqual(expect.arrayContaining(["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]))
  })

  test("uses LangChain's stateless Responses mode", () => {
    if (!codexProvider.buildModel) throw new Error("Codex must use the LangChain runtime")
    const model = codexProvider.buildModel({
      model: "gpt-5.6-terra",
      effort: "high",
    }) as any

    expect(model.responses.zdrEnabled).toBe(true)
    expect(model.invocationParams({}).store).toBe(false)
  })

  test("defaults Luna to Fast while respecting an explicit speed", () => {
    if (!codexProvider.buildModel) throw new Error("Codex must use the LangChain runtime")
    const paramsFor = (selection: Record<string, unknown>) =>
      (codexProvider.buildModel!(selection as any) as any).invocationParams({})

    expect(paramsFor({ model: "gpt-5.6-luna" }).service_tier).toBe("priority")
    expect(paramsFor({ model: "gpt-5.6-luna", speed: "standard" }).service_tier).toBeUndefined()
    expect(paramsFor({ model: "gpt-5.6-luna", speed: "fast" }).service_tier).toBe("priority")
    expect(paramsFor({ model: "gpt-5.6-terra" }).service_tier).toBeUndefined()
  })

  test("uses the Responses Lite contract only for Luna", () => {
    const lunaHeaders = new Headers({ "content-length": "123", "session-id": "legacy-session" })
    const luna = JSON.parse(
      prepareCodexResponsesRequest(
        JSON.stringify({
          model: "gpt-5.6-luna",
          input: [
            { role: "developer", content: [{ type: "input_text", text: "Be concise." }] },
            { role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,test", detail: "high" }] },
          ],
          tools: [{ type: "function", name: "noop", parameters: {}, strict: null }],
          reasoning: { effort: "high" },
          service_tier: "priority",
          parallel_tool_calls: true,
          max_output_tokens: 100,
        }),
        lunaHeaders,
      ),
    )

    expect(lunaHeaders.get("x-openai-internal-codex-responses-lite")).toBe("true")
    expect(lunaHeaders.get("version")).toBe("0.144.0")
    expect(lunaHeaders.get("session-id")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(lunaHeaders.get("x-session-affinity")).toBe(lunaHeaders.get("session-id"))
    expect(lunaHeaders.has("content-length")).toBe(false)
    expect(luna.prompt_cache_key).toBe(lunaHeaders.get("session-id"))
    expect(luna.tool_choice).toBe("auto")
    expect(luna.service_tier).toBe("priority")
    expect(luna.parallel_tool_calls).toBe(false)
    expect(luna.reasoning).toEqual({ effort: "high", context: "all_turns" })
    expect(luna.tools).toBeUndefined()
    expect(luna.instructions).toBeUndefined()
    expect(luna.max_output_tokens).toBeUndefined()
    expect(luna.input).toEqual([
      {
        type: "additional_tools",
        role: "developer",
        tools: [{ type: "function", name: "noop", parameters: {} }],
      },
      {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "Be concise." }],
      },
      { role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,test" }] },
    ])

    const terraHeaders = new Headers({ "content-length": "123", "session-id": "legacy-session" })
    const terraBody = JSON.stringify({ model: "gpt-5.6-terra", input: [], tools: [], parallel_tool_calls: true })
    const terra = JSON.parse(prepareCodexResponsesRequest(terraBody, terraHeaders))

    expect(terraHeaders.get("x-openai-internal-codex-responses-lite")).toBeNull()
    expect(terraHeaders.get("version")).toBeNull()
    expect(terraHeaders.get("session-id")).toBe("legacy-session")
    expect(terraHeaders.get("content-length")).toBe("123")
    expect(terra).toEqual({ model: "gpt-5.6-terra", input: [], tools: [], parallel_tool_calls: true })
  })

  test("swaps a matching compaction boundary", () => {
    const result = JSON.parse(swapCodexCompactionHistory(JSON.stringify({ model: "gpt-5.6-sol", input: [
      { role: "user", content: [{ type: "input_text", text: "old" }] },
      { role: "user", content: [{ type: "input_text", text: "summary boundary" }] },
      { role: "user", content: [{ type: "input_text", text: "tail" }] },
    ] }), { provider: "codex", model: "gpt-5.6-sol", boundary: "summary boundary", replacementHistory: [{ type: "compaction", encrypted_content: "opaque" }] }))
    expect(result.input.map((x: any) => x.type ?? x.content?.[0]?.text)).toEqual(["old", "compaction", "tail"])
  })

  test("refuses absent or mismatched compaction artifacts", () => {
    const body = JSON.stringify({ model: "gpt-5.6-sol", input: [{ role: "user", content: "summary" }] })
    expect(swapCodexCompactionHistory(body, null)).toBe(body)
    expect(swapCodexCompactionHistory(body, { provider: "codex", model: "gpt-5.6-terra", boundary: "summary", replacementHistory: [] })).toBe(body)
    expect(swapCodexCompactionHistory(body, { provider: "codex", model: "gpt-5.6-sol", boundary: "missing", replacementHistory: [] })).toBe(body)
  })

  test("matches wrapped summary text only when the boundary is unique", () => {
    const artifact = { provider: "codex", model: "gpt-5.6-sol", boundary: "older summary", replacementHistory: [{ type: "compaction", encrypted_content: "opaque" }] }
    const wrapped = JSON.stringify({ model: artifact.model, input: [{ role: "user", content: [{ type: "input_text", text: "prefix: older summary (wrapped)" }] }] })
    expect(JSON.parse(swapCodexCompactionHistory(wrapped, artifact)).input[0].type).toBe("compaction")
    const ambiguous = JSON.stringify({ model: artifact.model, input: [
      { role: "user", content: "older summary" },
      { role: "assistant", content: [{ type: "output_text", text: "older summary again" }] },
    ] })
    expect(swapCodexCompactionHistory(ambiguous, artifact)).toBe(ambiguous)
  })

  test("imports and refreshes Codex CLI auth without writing the CLI file", async () => {
    const dir = mkdtempSync(`${tmpdir()}/chunky-codex-cli-`)
    const oldHome = process.env.CODEX_HOME, oldAuth = process.env.CHUNKY_AUTH, oldFetch = globalThis.fetch
    process.env.CODEX_HOME = dir
    process.env.CHUNKY_AUTH = `${dir}/chunky-auth.json`
    writeFileSync(`${dir}/auth.json`, JSON.stringify({ tokens: { refresh_token: "cli-refresh", account_id: "acct-cli" } }))
    globalThis.fetch = (async () => new Response(JSON.stringify({ access_token: "fresh-access", refresh_token: "fresh-refresh", expires_in: 3600 }), { status: 200 })) as unknown as typeof fetch
    try {
      expect(await tryImportCodexCliAuth()).toBe(true)
      expect(AuthStore.get("codex")).toMatchObject({ access: "fresh-access", refresh: "fresh-refresh", accountId: "acct-cli" })
      expect(await validAuth()).toMatchObject({ access: "fresh-access" })
    } finally {
      globalThis.fetch = oldFetch; if (oldHome == null) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldHome
      if (oldAuth == null) delete process.env.CHUNKY_AUTH; else process.env.CHUNKY_AUTH = oldAuth
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("CLI auth import fails silently for malformed, missing, and rejected files", async () => {
    const dir = mkdtempSync(`${tmpdir()}/chunky-codex-cli-`)
    const oldHome = process.env.CODEX_HOME, oldAuth = process.env.CHUNKY_AUTH, oldFetch = globalThis.fetch
    process.env.CODEX_HOME = dir; process.env.CHUNKY_AUTH = `${dir}/chunky-auth.json`
    try {
      writeFileSync(`${dir}/auth.json`, "not-json")
      expect(await tryImportCodexCliAuth()).toBe(false)
      const missing = mkdtempSync(`${tmpdir()}/chunky-codex-cli-missing-`)
      process.env.CODEX_HOME = missing
      expect(await tryImportCodexCliAuth()).toBe(false)
      process.env.CODEX_HOME = dir
      writeFileSync(`${dir}/auth.json`, JSON.stringify({ tokens: { refresh_token: "bad" } }))
      // Import failures are cached per auth path, so use a fresh path for the rejected refresh.
      const rejected = mkdtempSync(`${tmpdir()}/chunky-codex-cli-rejected-`)
      process.env.CODEX_HOME = rejected
      writeFileSync(`${rejected}/auth.json`, JSON.stringify({ tokens: { refresh_token: "bad" } }))
      globalThis.fetch = (async () => new Response("no", { status: 401 })) as unknown as typeof fetch
      expect(await tryImportCodexCliAuth()).toBe(false)
      rmSync(missing, { recursive: true, force: true }); rmSync(rejected, { recursive: true, force: true })
    } finally {
      globalThis.fetch = oldFetch; if (oldHome == null) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldHome
      if (oldAuth == null) delete process.env.CHUNKY_AUTH; else process.env.CHUNKY_AUTH = oldAuth
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
