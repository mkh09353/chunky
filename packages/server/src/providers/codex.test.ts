import { describe, expect, test } from "bun:test"
import { codexProvider } from "./codex.ts"

describe("codex provider", () => {
  test("uses LangChain's stateless Responses mode", () => {
    if (!codexProvider.buildModel) throw new Error("Codex must use the LangChain runtime")
    const model = codexProvider.buildModel({
      model: "gpt-5.6-terra",
      effort: "high",
    }) as any

    expect(model.responses.zdrEnabled).toBe(true)
    expect(model.invocationParams({}).store).toBe(false)
  })
})
