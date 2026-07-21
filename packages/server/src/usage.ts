// Token extractors for the two agent loops (LangChain + Anthropic SDK). These
// pull the prompt-cache-relevant token counts (input / cacheRead / cacheWrite)
// out of provider-shaped usage blobs. The only consumer is cache-watch.ts,
// which uses them to size the prompt that a cold cache would force us to re-send
// — we deliberately do NOT track cost here.
import type { UsageDelta } from "@chunky/protocol"

/** Prompt tokens a request billed: everything that had to be present as input,
 *  whether fresh, cache-read, or cache-written. Approximates the context size. */
export function promptTokensOf(delta: UsageDelta): number {
  return (delta.inputTokens || 0) + (delta.cacheReadTokens || 0) + (delta.cacheWriteTokens || 0)
}

/** Pull token counts out of a LangChain AIMessage / AIMessageChunk. */
export function usageFromLangChainMessage(msg: unknown): UsageDelta | null {
  if (!msg || typeof msg !== "object") return null
  const m = msg as {
    usage_metadata?: {
      input_tokens?: number
      output_tokens?: number
      input_token_details?: { cache_read?: number; cache_creation?: number }
      output_token_details?: { reasoning?: number }
    }
    response_metadata?: {
      usage?: {
        prompt_tokens?: number
        completion_tokens?: number
        total_tokens?: number
        prompt_tokens_details?: { cached_tokens?: number }
        completion_tokens_details?: { reasoning_tokens?: number }
      }
      tokenUsage?: {
        promptTokens?: number
        completionTokens?: number
        totalTokens?: number
      }
    }
  }

  const um = m.usage_metadata
  if (um && (typeof um.input_tokens === "number" || typeof um.output_tokens === "number")) {
    const cacheRead = um.input_token_details?.cache_read
    const cacheWrite = um.input_token_details?.cache_creation
    const reasoning = um.output_token_details?.reasoning
    return {
      inputTokens: um.input_tokens ?? 0,
      outputTokens: um.output_tokens ?? 0,
      ...(typeof cacheRead === "number" ? { cacheReadTokens: cacheRead } : {}),
      ...(typeof cacheWrite === "number" ? { cacheWriteTokens: cacheWrite } : {}),
      ...(typeof reasoning === "number" ? { reasoningTokens: reasoning } : {}),
    }
  }

  const u = m.response_metadata?.usage
  if (u && (typeof u.prompt_tokens === "number" || typeof u.completion_tokens === "number")) {
    const cached = u.prompt_tokens_details?.cached_tokens
    const reasoning = u.completion_tokens_details?.reasoning_tokens
    return {
      inputTokens: u.prompt_tokens ?? 0,
      outputTokens: u.completion_tokens ?? 0,
      ...(typeof cached === "number" ? { cacheReadTokens: cached } : {}),
      ...(typeof reasoning === "number" ? { reasoningTokens: reasoning } : {}),
    }
  }

  const tu = m.response_metadata?.tokenUsage
  if (tu && (typeof tu.promptTokens === "number" || typeof tu.completionTokens === "number")) {
    return {
      inputTokens: tu.promptTokens ?? 0,
      outputTokens: tu.completionTokens ?? 0,
    }
  }

  return null
}

/** Pull token counts from an Anthropic Agent SDK `result` message. */
export function usageFromAnthropicResult(message: {
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_creation_input_tokens?: number | null
    cache_read_input_tokens?: number | null
    reasoning_tokens?: number | null
  }
  modelUsage?: Record<
    string,
    {
      inputTokens?: number
      outputTokens?: number
      cacheReadInputTokens?: number
      cacheCreationInputTokens?: number
      reasoningTokens?: number
    }
  >
}): UsageDelta {
  // Prefer the per-model breakdown when present (handles multi-model turns);
  // fall back to the flat `usage` block.
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let cacheWriteTokens = 0
  let reasoningTokens = 0
  let model: string | undefined

  const models = message.modelUsage ? Object.entries(message.modelUsage) : []
  if (models.length > 0) {
    // Label the delta with the model that carried the LARGEST prompt — the one
    // actually running the conversation. The SDK's breakdown also lists its
    // auxiliary calls (e.g. Haiku title generation), and "first enumerated" can
    // be one of those.
    let biggestPrompt = -1
    for (const [id, mu] of models) {
      inputTokens += mu.inputTokens ?? 0
      outputTokens += mu.outputTokens ?? 0
      cacheReadTokens += mu.cacheReadInputTokens ?? 0
      cacheWriteTokens += mu.cacheCreationInputTokens ?? 0
      reasoningTokens += mu.reasoningTokens ?? 0
      const prompt = (mu.inputTokens ?? 0) + (mu.cacheReadInputTokens ?? 0) + (mu.cacheCreationInputTokens ?? 0)
      if (prompt > biggestPrompt) {
        biggestPrompt = prompt
        model = id
      }
    }
  } else if (message.usage) {
    inputTokens = message.usage.input_tokens ?? 0
    outputTokens = message.usage.output_tokens ?? 0
    cacheReadTokens = message.usage.cache_read_input_tokens ?? 0
    cacheWriteTokens = message.usage.cache_creation_input_tokens ?? 0
    reasoningTokens = message.usage.reasoning_tokens ?? 0
  }

  return {
    inputTokens,
    outputTokens,
    ...(cacheReadTokens ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens ? { cacheWriteTokens } : {}),
    ...(reasoningTokens ? { reasoningTokens } : {}),
    ...(model ? { model } : {}),
  }
}

/**
 * Extract only the prompt usage belonging to the configured conversation model.
 * `modelUsage` may also contain SDK-owned auxiliary calls (for example title
 * generation), which are valid billing/usage totals but are not part of the
 * prompt that a cold conversation cache would resend.
 *
 * The configured id is preferred, with a case-insensitive exact match as a
 * small compatibility concession. If the SDK does not expose that id, use a
 * deterministic largest-prompt fallback: this is the best available proxy for
 * the conversation request, and ties are resolved lexically rather than by
 * object enumeration order. Flat usage is used when no model breakdown exists.
 */
export function usageForAnthropicCache(
  message: Parameters<typeof usageFromAnthropicResult>[0],
  configuredModel?: string,
): UsageDelta {
  const models = message.modelUsage ? Object.entries(message.modelUsage) : []
  if (models.length === 0) return usageFromAnthropicResult(message)

  const configured = configuredModel
    ? models.find(([id]) => id === configuredModel) ??
      models.find(([id]) => id.toLowerCase() === configuredModel.toLowerCase())
    : undefined
  const selected = configured ?? [...models].sort(([a, av], [b, bv]) => {
    const ap = (av.inputTokens ?? 0) + (av.cacheReadInputTokens ?? 0) + (av.cacheCreationInputTokens ?? 0)
    const bp = (bv.inputTokens ?? 0) + (bv.cacheReadInputTokens ?? 0) + (bv.cacheCreationInputTokens ?? 0)
    return bp - ap || a.localeCompare(b)
  })[0]
  const [, usage] = selected
  return {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    ...(usage.cacheReadInputTokens ? { cacheReadTokens: usage.cacheReadInputTokens } : {}),
    ...(usage.cacheCreationInputTokens ? { cacheWriteTokens: usage.cacheCreationInputTokens } : {}),
    ...(usage.reasoningTokens ? { reasoningTokens: usage.reasoningTokens } : {}),
    model: selected[0],
  }
}
