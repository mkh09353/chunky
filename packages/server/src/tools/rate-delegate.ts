import { tool } from "@langchain/core/tools"
import { z } from "zod"
import { threadContextFor } from "../thread-context.ts"
import { Store } from "../store.ts"
import { activeSelection } from "../providers/registry.ts"

export const rateDelegate = tool(async (input, config?: unknown) => {
  const thread = (config as any)?.configurable?.thread_id as string | undefined
  const ctx = threadContextFor(thread)
  if (!ctx || !thread) return "error: rate_delegate is only available to the lead."
  const id = Store.resolveDelegation(ctx.sessionId, input.delegation)
  if (!id) return "error: delegation not found"
  Store.rateDelegation(id, input.rating, input.rework ?? false, input.reason, activeSelection())
  return `Rated delegation ${id}: ${input.rating}/10`
}, { name: "rate_delegate", description: "Rate completed delegated work.", schema: z.object({ delegation: z.string(), rating: z.number().int().min(1).max(10), rework: z.boolean().optional(), reason: z.string().min(1) }) })
