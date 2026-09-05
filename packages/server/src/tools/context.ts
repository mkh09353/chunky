// Context-budget tools. The LangChain runtime measures prompt tokens in
// chunkyCompactionMiddleware before every model call; these tools expose that
// measurement and let a thread schedule its own compaction at a clean point.
// Anthropic SDK runs bypass that middleware, so they get an informative message.
import { tool } from "@langchain/core/tools"
import { z } from "zod"
import { COMPACTION_TRIGGER_TOKENS, COMPACTION_WARN_TOKENS, contextUsageFor, requestCompaction } from "../compaction.ts"

export const MAX_COMPACTION_HINT_CHARS = 2000

export const getContextRemainingDescription =
  "Report approximately how many prompt tokens this thread used before its last model call, how many remain before older messages are automatically summarized, and where the pre-compaction warning fires. " +
  "Counts are approximate. Use it to decide when to checkpoint your persistent notes (notes tool) or call compact_context."

export const compactContextDescription =
  "Schedule compaction of this thread's context before your next model call. Only call it after your persistent notes are current (notes tool: goal, decisions, findings, why fixes failed, next steps, and recall seqs/turns/keywords for evidence), " +
  "because the summary is lossy while notes are re-injected verbatim. Only the calling thread is compacted; the optional hint (max 2000 chars) tells the summarizer what to emphasize."

export const getContextRemainingInputShape = {}
export const compactContextInputShape = {
  hint: z.string().max(MAX_COMPACTION_HINT_CHARS).optional().describe("Optional focus for the summarizer, e.g. what must be preserved."),
}

type Config = { configurable?: { thread_id?: unknown; runtime?: unknown } }
const threadOf = (config: unknown) => {
  const value = (config as Config | undefined)?.configurable?.thread_id
  return typeof value === "string" && value ? value : undefined
}
const isAnthropicRuntime = (config: unknown) => (config as Config | undefined)?.configurable?.runtime === "anthropic-sdk"

export function formatContextRemaining(usage: { total: number } | undefined): string {
  if (!usage) return "no measurement yet — context is measured before each model call in this thread."
  const used = Math.round(usage.total)
  const remaining = Math.max(0, COMPACTION_TRIGGER_TOKENS - used)
  return `approx ${used} tokens used of ${COMPACTION_TRIGGER_TOKENS} before automatic compaction; ~${remaining} remaining (warning at ${COMPACTION_WARN_TOKENS}). Measured before your last model call.`
}

export const get_context_remaining = tool(
  async (_input: Record<string, never>, config?: unknown) => {
    if (isAnthropicRuntime(config)) return "no measurement available in this runtime"
    const threadId = threadOf(config)
    if (!threadId) return "no measurement yet — get_context_remaining is only available inside an active session run."
    return formatContextRemaining(contextUsageFor(threadId))
  },
  { name: "get_context_remaining", description: getContextRemainingDescription, schema: z.object(getContextRemainingInputShape) },
)

export const compact_context = tool(
  async ({ hint }: { hint?: string }, config?: unknown) => {
    if (isAnthropicRuntime(config)) return "error: manual compaction is not available in this runtime"
    const threadId = threadOf(config)
    if (!threadId) return "error: compact_context is only available inside an active session run."
    if (hint && hint.length > MAX_COMPACTION_HINT_CHARS) return `error: hint must be at most ${MAX_COMPACTION_HINT_CHARS} characters.`
    requestCompaction(threadId, hint)
    return "Compaction scheduled before your next model call; your notes will be re-injected."
  },
  { name: "compact_context", description: compactContextDescription, schema: z.object(compactContextInputShape) },
)

export const contextTools = [get_context_remaining, compact_context]
