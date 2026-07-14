// sidekick — hand a brief to the persistent worker side thread. Unlike
// spawn_thread (a fresh, run-to-completion child), the sidekick is ONE standing
// thread per session on a stable thread_id: it keeps the repo context it built
// across handoffs, so a follow-up brief ("the diff has a bug in the error path —
// fix it") is cheap. Mirrors spawn_thread's shape — it finds the active run's
// ThreadManager via configurable.thread_id and delegates to delegateToSidekick.
import { tool } from "@langchain/core/tools"
import { z } from "zod"
import { threadContextFor } from "../thread-context.ts"

const DESCRIPTION = `Hand a work brief to your sidekick — a persistent worker agent (its own side thread, usually a cheaper model) that does the hands-on loop: reading code, editing files, running builds and tests. It remembers earlier briefs this session, so follow-ups can be short ("fix the failing test in the diff you just wrote").

This is your DEFAULT way to delegate implementation. Write the brief like a spec, not like code: state the goal, enumerate the constraints and edge cases explicitly (a constraint you don't write down will not survive the handoff), and define done. Don't dictate the implementation line by line — specify outcomes and let it work.

After it reports back, review with git diff/git show — do NOT pull its files into your context or rewrite its work yourself. If the work is wrong, hand back a follow-up brief with specific feedback instead of fixing it at lead prices. Delegate early: if the hands-on work is separable, hand it off before you've read half the repo yourself.

Skip the sidekick when the task isn't separable: quick answers, single-line fixes, or serial debugging where your accumulated context IS the work.`

export const sidekickInputShape = {
  task: z.string().describe("The goal: what to build/change/investigate and why, in plain language."),
  constraints: z
    .array(z.string())
    .optional()
    .describe(
      "Hard requirements and edge cases, each stated explicitly (e.g. 'operator() must be O(1) in pointer length: " +
        "NO full token scan'). Anything not written here will not survive the handoff.",
    ),
  done_when: z
    .string()
    .optional()
    .describe("Definition of done: what must pass/exist for the work to be complete (tests green, lint clean, etc.)."),
  pointers: z
    .string()
    .optional()
    .describe("Where to start: relevant files/lines/commands. Point, don't paste whole files."),
}

export interface SidekickInput {
  task: string
  constraints?: string[]
  done_when?: string
  pointers?: string
}

/** Assemble the structured fields into the one plain-language brief the sidekick
 *  receives. Exported for tests. */
export function composeBrief(input: SidekickInput): string {
  const parts = [input.task]
  if (input.constraints?.length) parts.push(`Constraints:\n${input.constraints.map((c) => `- ${c}`).join("\n")}`)
  if (input.done_when) parts.push(`Done when: ${input.done_when}`)
  if (input.pointers) parts.push(`Where to look:\n${input.pointers}`)
  return parts.join("\n\n")
}

export const sidekick = tool(
  async (input: SidekickInput, config?: unknown) => {
    const callerThreadId = (config as any)?.configurable?.thread_id as string | undefined
    const ctx = threadContextFor(callerThreadId)
    if (!ctx || !callerThreadId) {
      return "error: sidekick is only available inside an active session run."
    }
    return ctx.delegateToSidekick({ callerThreadId, brief: composeBrief(input) })
  },
  {
    name: "sidekick",
    description: DESCRIPTION,
    schema: z.object(sidekickInputShape),
  },
)
