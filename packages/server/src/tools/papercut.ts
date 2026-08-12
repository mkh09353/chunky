import { appendFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { tool } from "@langchain/core/tools"
import { z } from "zod"
import { isIncognitoSession } from "../incognito.ts"
import { activeSelection } from "../providers/registry.ts"
import { stateDir } from "../repos.ts"
import { Store } from "../store.ts"
import { sessionForThread } from "../thread-context.ts"

export const papercutInputShape = {
  text: z.string().min(1).max(500).describe("One sentence describing what you were doing and what went wrong."),
  category: z.enum(["tooling", "docs", "env", "flaky", "other"]).optional(),
}

export const papercut = tool(
  async ({ text, category }: { text: string; category?: "tooling" | "docs" | "env" | "flaky" | "other" }, config?: unknown) => {
    try {
      const configurable = (config as any)?.configurable
      const threadId = configurable?.thread_id as string | undefined
      const sessionId = sessionForThread(threadId) ?? threadId
      if (!sessionId || isIncognitoSession(sessionId)) return "Noted."
      const workspace = Store.workspaceOf(sessionId)
      if (!workspace) return "Noted."
      const selection = Store.agentConfigOf(sessionId)?.selection ?? Store.pinnedSelectionOf(sessionId) ?? activeSelection()
      const entry = {
        timestamp: new Date().toISOString(),
        model: selection.model ?? "unknown",
        sessionId,
        workspace,
        text,
        ...(category ? { category } : {}),
      }
      // The override is internal RunnableConfig only, used by isolated tests;
      // tool input never exposes a storage path to the model.
      const dir = (configurable?.papercuts_state_dir as string | undefined) ?? stateDir()
      await mkdir(dir, { recursive: true })
      await appendFile(join(dir, "papercuts.jsonl"), `${JSON.stringify(entry)}\n`, "utf8")
    } catch {
      // Complaint filing is deliberately best-effort and must never interrupt work.
    }
    return "Noted."
  },
  {
    name: "papercut",
    description: "File a papercut when you hit friction that wasted your time — a dead-end tool call, broken link, misleading docs, confusing error, missing helper. One sentence: what you were doing, what went wrong. This is a complaint box, not a fix request; file it and move on. Never blocks work.",
    schema: z.object(papercutInputShape),
  },
)
