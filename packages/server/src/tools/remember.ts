import { tool } from "@langchain/core/tools"
import { z } from "zod"
import { appendRepoMemory } from "../memory.ts"
import { Store } from "../store.ts"
import { sessionForThread } from "../thread-context.ts"

export const rememberInputShape = { text: z.string().min(1).max(1000).describe("A concise lesson, one or two sentences.") }
export const remember = tool(
  async ({ text }: { text: string }, config?: unknown) => {
    const threadId = (config as any)?.configurable?.thread_id as string | undefined
    const sessionId = sessionForThread(threadId) ?? threadId
    if (!sessionId) return "error: remember is only available inside an active session run."
    const workspace = Store.workspaceOf(sessionId)
    if (!workspace) return "error: unknown session workspace."
    return appendRepoMemory(workspace, text, sessionId) ? "Remembered." : "error: could not save memory (incognito sessions do not retain memory)."
  },
  { name: "remember", description: "Append a short, repeatable repository lesson to Chunky's durable memory. Use only for real failures, environment quirks, or workflow rules — not routine notes.", schema: z.object(rememberInputShape) },
)
