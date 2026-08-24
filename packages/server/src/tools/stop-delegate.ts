// stop_delegate — cancel a live sidekick brief or detached spawn without
// aborting the lead turn. Targets a detached run by id, or a sidekick by seat
// (omitted seat = default, only when unambiguous).
import { tool } from "@langchain/core/tools"
import { z } from "zod"
import type { StopDelegateResponse } from "@chunky/protocol"
import { threadContextFor } from "../thread-context.ts"

export const stopDelegateInputShape = {
  runId: z
    .string()
    .optional()
    .describe("Detached run id from a detach=true sidekick or spawn_thread launch. Prefer this when you have it."),
  seat: z
    .string()
    .optional()
    .describe(
      'Named sidekick seat to stop (e.g. "frontend"). Omit for the default seat. Ignored when runId is set.',
    ),
}

export interface StopDelegateInput {
  runId?: string
  seat?: string
}

export async function runStopDelegate(
  sessionId: string,
  input: StopDelegateInput,
  source: "user" | "lead" = "lead",
): Promise<StopDelegateResponse> {
  // Dynamic import avoids agent.ts -> this file -> threads.ts -> agent.ts.
  const { stopDelegate } = await import("../threads.ts")
  return stopDelegate(sessionId, { runId: input.runId, seat: input.seat }, source)
}

export const stopDelegateTool = tool(
  async (input: StopDelegateInput, config?: unknown) => {
    const callerThreadId = (config as any)?.configurable?.thread_id as string | undefined
    const ctx = threadContextFor(callerThreadId)
    if (!ctx || !callerThreadId) {
      return "error: stop_delegate is only available inside an active session run."
    }
    const result = await runStopDelegate(ctx.sessionId, input, "lead")
    return result.message
  },
  {
    name: "stop_delegate",
    description:
      "Cancel a live sidekick brief or detached spawn without stopping your own turn. Pass runId for a detached child; pass seat (or omit it for the default seat) to stop the in-flight sidekick on that seat. Idempotent after the worker has already finished.",
    schema: z.object(stopDelegateInputShape),
  },
)
