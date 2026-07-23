import { tool } from "@langchain/core/tools"
import { z } from "zod"
import { threadContextFor } from "../thread-context.ts"

export const reviewInputShape = {
  brief: z.string().describe("Concise description of the substantive change and what should be reviewed."),
  pointers: z.string().optional().describe("Optional files, diff areas, risks, or tests to focus on. Point, don't paste."),
}

export const review = tool(async ({ brief, pointers }: { brief: string; pointers?: string }, config?: unknown) => {
  const callerThreadId = (config as any)?.configurable?.thread_id as string | undefined
  const ctx = threadContextFor(callerThreadId)
  if (!ctx?.launchReview || !callerThreadId) return "error: review is only available inside an active session run."
  return ctx.launchReview({ callerThreadId, brief, pointers })
}, {
  name: "review",
  description: "Launch one asynchronous read-only code review near completion for substantive work. It returns immediately with a review id; continue verification while it runs. Findings later wake an idle lead session or arrive as a reminder. Use only when a reviewer is configured; it is never automatic.",
  schema: z.object(reviewInputShape),
})
