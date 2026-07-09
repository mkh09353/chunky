// Map a picker selection's reasoning knobs onto ChatOpenAI constructor fields.
//
// Shapes mirror opencode's packages/core/src/v1/config/provider-options.ts,
// lowered for the OpenAI-compatible chat-completions transport that all three
// providers speak through LangChain's ChatOpenAI (@langchain/openai 1.5.x).
//
// Verified empirically (by intercepting the outbound request body to Zen):
//   reasoning effort -> `modelKwargs: { reasoning_effort }`. modelKwargs is
//     spread verbatim into the request body, so the key lands for ANY model id
//     served over the compatible endpoint — including non-OpenAI ids like
//     `claude-opus-4-8`. (The constructor `reasoning` / `reasoningEffort`
//     shorthands are gated/transformed by LangChain and did NOT emit
//     reasoning_effort on this path, so we set it directly.) "xhigh" passes
//     straight through as a string.
//   speed (Codex only) -> the `service_tier` field: "fast" lowers to OpenAI's
//     "priority" tier; "standard" sends nothing. Zen/Grok ignore speed.
import type { ModelSelection } from "../settings.ts"

/** ChatOpenAI constructor fragment carrying the reasoning effort (empty if unset). */
export function effortField(effort?: ModelSelection["effort"]): Record<string, unknown> {
  return effort ? { modelKwargs: { reasoning_effort: effort } } : {}
}

/** ChatOpenAI constructor fragment for a Codex speed setting (empty unless "fast"). */
export function speedField(speed?: ModelSelection["speed"]): Record<string, unknown> {
  return speed === "fast" ? { service_tier: "priority" } : {}
}

/**
 * Compose the ChatOpenAI constructor fields a selection implies. `withSpeed`
 * gates the Codex-only speed knob so Zen/Grok never emit service_tier. Spread
 * the result into the ChatOpenAI constructor options.
 */
export function chatOptionsFor(
  sel: ModelSelection,
  opts: { withSpeed?: boolean } = {},
): Record<string, unknown> {
  return {
    ...effortField(sel.effort),
    ...(opts.withSpeed ? speedField(sel.speed) : {}),
  }
}
