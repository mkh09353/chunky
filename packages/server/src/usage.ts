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
    }
    response_metadata?: {
      usage?: {
        prompt_tokens?: number
        completion_tokens?: number
        total_tokens?: number
        prompt_tokens_details?: { cached_tokens?: number }
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
    return {
      inputTokens: um.input_tokens ?? 0,
      outputTokens: um.output_tokens ?? 0,
      ...(typeof cacheRead === "number" ? { cacheReadTokens: cacheRead } : {}),
      ...(typeof cacheWrite === "number" ? { cacheWriteTokens: cacheWrite } : {}),
    }
  }

  const u = m.response_metadata?.usage
  if (u && (typeof u.prompt_tokens === "number" || typeof u.completion_tokens === "number")) {
    const cached = u.prompt_tokens_details?.cached_tokens
    return {
      inputTokens: u.prompt_tokens ?? 0,
      outputTokens: u.completion_tokens ?? 0,
      ...(typeof cached === "number" ? { cacheReadTokens: cached } : {}),
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
  }
  modelUsage?: Record<
    string,
    {
      inputTokens?: number
      outputTokens?: number
      cacheReadInputTokens?: number
      cacheCreationInputTokens?: number
    }
  >
}): UsageDelta {
  // Prefer the per-model breakdown when present (handles multi-model turns);
  // fall back to the flat `usage` block.
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let cacheWriteTokens = 0
  let model: string | undefined

  const models = message.modelUsage ? Object.entries(message.modelUsage) : []
  if (models.length > 0) {
    for (const [id, mu] of models) {
      inputTokens += mu.inputTokens ?? 0
      outputTokens += mu.outputTokens ?? 0
      cacheReadTokens += mu.cacheReadInputTokens ?? 0
      cacheWriteTokens += mu.cacheCreationInputTokens ?? 0
      if (!model) model = id
    }
  } else if (message.usage) {
    inputTokens = message.usage.input_tokens ?? 0
    outputTokens = message.usage.output_tokens ?? 0
    cacheReadTokens = message.usage.cache_read_input_tokens ?? 0
    cacheWriteTokens = message.usage.cache_creation_input_tokens ?? 0
  }

  return {
    inputTokens,
    outputTokens,
    ...(cacheReadTokens ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens ? { cacheWriteTokens } : {}),
    ...(model ? { model } : {}),
  }
}
