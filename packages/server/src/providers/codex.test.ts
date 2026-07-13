import { describe, expect, test } from "bun:test"
import { codexProvider, prepareCodexResponsesRequest } from "./codex.ts"

describe("codex provider", () => {
  test("advertises every current GPT-5.6 Codex model", async () => {
    const ids = (await codexProvider.listModels()).map((model) => model.id)

    expect(ids).toEqual(expect.arrayContaining(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]))
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
})
