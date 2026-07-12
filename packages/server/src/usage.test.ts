import { describe, expect, test } from "bun:test"
import {
  promptTokensOf,
  usageFromAnthropicResult,
  usageFromLangChainMessage,
} from "./usage.ts"

describe("promptTokensOf", () => {
  test("sums input + cache read + cache write", () => {
    expect(
      promptTokensOf({ inputTokens: 500, outputTokens: 40, cacheReadTokens: 1500, cacheWriteTokens: 200 }),
    ).toBe(2200)
  })

  test("tolerates missing cache fields", () => {
    expect(promptTokensOf({ inputTokens: 120, outputTokens: 10 })).toBe(120)
  })
})

describe("usageFromLangChainMessage", () => {
  test("reads usage_metadata (preferred)", () => {
    const delta = usageFromLangChainMessage({
      usage_metadata: {
        input_tokens: 120,
        output_tokens: 40,
        input_token_details: { cache_read: 80, cache_creation: 10 },
        output_token_details: { reasoning: 12 },
      },
    })
    expect(delta).toEqual({
      inputTokens: 120,
      outputTokens: 40,
      cacheReadTokens: 80,
      cacheWriteTokens: 10,
      reasoningTokens: 12,
    })
  })

  test("falls back to response_metadata.usage", () => {
    const delta = usageFromLangChainMessage({
      response_metadata: {
        usage: {
          prompt_tokens: 50,
          completion_tokens: 10,
          prompt_tokens_details: { cached_tokens: 20 },
          completion_tokens_details: { reasoning_tokens: 4 },
        },
      },
    })
    expect(delta).toEqual({
      inputTokens: 50,
      outputTokens: 10,
      cacheReadTokens: 20,
      reasoningTokens: 4,
    })
  })

  test("returns null when no usage present", () => {
    expect(usageFromLangChainMessage({ content: "hi" })).toBeNull()
    expect(usageFromLangChainMessage(null)).toBeNull()
  })
})

describe("usageFromAnthropicResult", () => {
  test("sums modelUsage across models and picks a model id", () => {
    const delta = usageFromAnthropicResult({
      modelUsage: {
        "claude-sonnet-4-5": {
          inputTokens: 1000,
          outputTokens: 200,
          cacheReadInputTokens: 400,
          cacheCreationInputTokens: 50,
          reasoningTokens: 30,
        },
        "claude-opus-4-6": { inputTokens: 100, outputTokens: 50 },
      },
    })
    expect(delta.inputTokens).toBe(1100)
    expect(delta.outputTokens).toBe(250)
    expect(delta.cacheReadTokens).toBe(400)
    expect(delta.cacheWriteTokens).toBe(50)
    expect(delta.reasoningTokens).toBe(30)
    expect(delta.model).toBe("claude-sonnet-4-5")
  })

  test("falls back to flat usage when modelUsage missing", () => {
    const delta = usageFromAnthropicResult({
      usage: {
        input_tokens: 42,
        output_tokens: 7,
        cache_read_input_tokens: 10,
        cache_creation_input_tokens: null,
        reasoning_tokens: 3,
      },
    })
    expect(delta).toEqual({
      inputTokens: 42,
      outputTokens: 7,
      cacheReadTokens: 10,
      reasoningTokens: 3,
    })
  })
})
