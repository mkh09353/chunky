import { tool } from "@langchain/core/tools"
import { z } from "zod"
import { threadContextFor } from "../thread-context.ts"
import { Store } from "../store.ts"
import { activeSelection } from "../providers/registry.ts"

/** Deterministic 1–10 rating from anchored sub-scores; rework caps at 7. */
export function computeRating(s: { compliance: number; correctness: number; report: number; exceeded: number; rework: boolean }): number {
  const raw = 1 + s.compliance + s.correctness + s.report + s.exceeded
  return s.rework ? Math.min(raw, 7) : raw
}

export const rateDelegateInputShape = {
  delegation: z.string(),
  compliance: z.number().int().min(0).max(3).describe("Brief coverage: 3 = every area/constraint of the brief delivered; 2 = complete except one minor gap; 1 = significant scope missing or a constraint violated; 0 = mostly not done."),
  correctness: z.number().int().min(0).max(3).describe("Does it work: 3 = verified (tests/build/smoke) with no known flaws; 2 = works but with minor issues or thin verification; 1 = has a real flaw needing a fix; 0 = broken or unverifiable."),
  report: z.number().int().min(0).max(2).describe("Report quality + honesty: 2 = precise, actionable, and candid about its own gaps/skips; 1 = adequate; 0 = vague, misleading, or silently omitted failures/skips."),
  exceeded: z.number().int().min(0).max(1).optional().describe("1 ONLY if it delivered clear value beyond the brief (caught a bug the brief missed, fixed a pre-existing issue) — name it in reason. Default 0."),
  rework: z.boolean().optional().describe("true if you had to send a follow-up brief to fix or finish this work (mechanical fact, not a judgment). Caps the rating at 7."),
  reason: z.string().min(1).describe("One concise line of evidence justifying the sub-scores; if exceeded=1, name the extra value."),
}

export const rateDelegate = tool(async (input, config?: unknown) => {
  const thread = (config as any)?.configurable?.thread_id as string | undefined
  const ctx = threadContextFor(thread)
  if (!ctx || !thread) return "error: rate_delegate is only available to the lead."
  const id = Store.resolveDelegation(ctx.sessionId, input.delegation)
  if (!id) return "error: delegation not found"
  const rework = input.rework ?? false
  const rating = computeRating({ compliance: input.compliance, correctness: input.correctness, report: input.report, exceeded: input.exceeded ?? 0, rework })
  const reason = `[c${input.compliance}/3 x${input.correctness}/3 r${input.report}/2 +${input.exceeded ?? 0}] ${input.reason}`
  Store.rateDelegation(id, rating, rework, reason, activeSelection())
  return `Rated delegation ${id}: ${rating}/10 (compliance ${input.compliance}/3, correctness ${input.correctness}/3, report ${input.report}/2, exceeded +${input.exceeded ?? 0}${rework ? ", capped at 7 for rework" : ""})`
}, {
  name: "rate_delegate",
  description: "Rate completed delegated work via anchored sub-scores; the 1–10 rating is COMPUTED (1 + compliance + correctness + report + exceeded, capped at 7 when rework=true), never chosen directly. Score strictly from evidence (the diff, test output, the report) — most solid runs should land 7–8; 9–10 must be rare and earned.",
  schema: z.object(rateDelegateInputShape),
})
