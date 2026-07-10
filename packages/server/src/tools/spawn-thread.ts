// spawn_thread — delegate a subtask to a full, independent child agent thread.
// The implementation lives outside agent.ts so both the LangChain harness and
// the Anthropic Agent SDK MCP adapter invoke the exact same thread machinery.
import { tool } from "@langchain/core/tools"
import { z } from "zod"
import type { Effort, Speed } from "../providers/registry.ts"
import { threadContextFor } from "../thread-context.ts"

export interface SpawnThreadInput {
  title: string
  instructions: string
  provider?: string
  model?: string
  effort?: Effort
  speed?: Speed
}

export const spawnThreadInputShape = {
  title: z.string().describe("Short title shown in the UI (e.g. 'List project files')."),
  instructions: z.string().describe("Full task/instructions for the child agent."),
  provider: z.string().optional().describe("Optional provider id for the child; defaults to this thread's provider."),
  model: z.string().optional().describe("Optional model id for the child; defaults to the inherited/provider selection."),
  effort: z.enum(["low", "medium", "high", "xhigh"]).optional().describe("Optional reasoning effort for the child."),
  speed: z.enum(["standard", "fast"]).optional().describe("Optional speed setting for the child."),
}

export async function runSpawnThread(input: SpawnThreadInput, callerThreadId: string | undefined): Promise<string> {
  const ctx = threadContextFor(callerThreadId)
  if (!ctx || !callerThreadId) {
    return "error: spawn_thread is only available inside an active session run."
  }

  const { title, instructions, provider, model, effort, speed } = input
  const hasSelectionOverride = provider !== undefined || model !== undefined || effort !== undefined || speed !== undefined
  const text = await ctx.spawn({
    callerThreadId,
    title,
    instructions,
    selection: hasSelectionOverride ? { provider, model, effort, speed } : undefined,
  })
  return `Child thread "${title}" finished.\n\n${text}`
}

export const spawnThread = tool(
  async (input: SpawnThreadInput, config?: unknown) => {
    const callerThreadId = (config as any)?.configurable?.thread_id as string | undefined
    return runSpawnThread(input, callerThreadId)
  },
  {
    name: "spawn_thread",
    description:
      "Delegate a focused subtask to an independent child agent thread that streams its own work live and can " +
      "spawn its own children. Omit model-selection fields to inherit this thread's model, or choose a configured " +
      "provider/model when a different model is better suited. Returns the child thread's final answer.",
    schema: z.object(spawnThreadInputShape),
  },
)
