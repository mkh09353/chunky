import { describe, expect, test } from "bun:test"
import {
  promptTokensOf,
  usageForAnthropicCache,
  usageFromAnthropicAssistant,
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

describe("usageFromAnthropicAssistant", () => {
  test("reads a single request's usage off message.usage", () => {
    expect(
      usageFromAnthropicAssistant({
        message: {
          model: "claude-fable-5-20260601",
          usage: { input_tokens: 900, output_tokens: 50, cache_read_input_tokens: 58_000, cache_creation_input_tokens: 1_200 },
        },
      }),
    ).toEqual({
      inputTokens: 900,
      outputTokens: 50,
      cacheReadTokens: 58_000,
      cacheWriteTokens: 1_200,
      model: "claude-fable-5-20260601",
    })
  })

  test("returns null without a usage block", () => {
    expect(usageFromAnthropicAssistant({ message: { model: "x" } })).toBeNull()
    expect(usageFromAnthropicAssistant(undefined)).toBeNull()
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

  test("labels the delta with the LARGEST-prompt model, not the first enumerated", () => {
    // The Agent SDK's modelUsage also lists its auxiliary calls (Haiku title
    // generation etc.). When one of those enumerates first, it must not label
    // the turn — that mislabeled a Fable thread as Haiku and manufactured a
    // false "model switch" cache warning.
    const delta = usageFromAnthropicResult({
      modelUsage: {
        "claude-haiku-4-5-20251001": { inputTokens: 300, outputTokens: 12 },
        "claude-fable-5": {
          inputTokens: 2000,
          outputTokens: 400,
          cacheReadInputTokens: 140_000,
        },
      },
    })
    expect(delta.model).toBe("claude-fable-5")
    expect(delta.inputTokens).toBe(2300)
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

describe("usageForAnthropicCache", () => {
  test("uses the configured primary model and excludes auxiliary prompt usage", () => {
    const delta = usageForAnthropicCache(
      {
        modelUsage: {
          "claude-haiku-4-5": {
            inputTokens: 300_000,
            outputTokens: 12_000,
            cacheReadInputTokens: 80_000,
          },
          "claude-sonnet-4-5": {
            inputTokens: 12_000,
            outputTokens: 900,
            cacheReadInputTokens: 40_000,
            cacheCreationInputTokens: 2_000,
            reasoningTokens: 300,
          },
        },
      },
      "claude-sonnet-4-5",
    )
    expect(delta).toEqual({
      inputTokens: 12_000,
      outputTokens: 900,
      cacheReadTokens: 40_000,
      cacheWriteTokens: 2_000,
      reasoningTokens: 300,
      model: "claude-sonnet-4-5",
    })
    expect(promptTokensOf(delta)).toBe(54_000)
  })

  test("uses a deterministic largest-prompt fallback when configured model is absent", () => {
    const delta = usageForAnthropicCache({
      modelUsage: {
        "z-aux": { inputTokens: 10, cacheReadInputTokens: 20 },
        "b-primary": { inputTokens: 100, cacheCreationInputTokens: 50 },
        "a-tie": { inputTokens: 100, cacheCreationInputTokens: 50 },
      },
    }, "missing-model")
    expect(delta.model).toBe("a-tie")
    expect(promptTokensOf(delta)).toBe(150)
  })
})
