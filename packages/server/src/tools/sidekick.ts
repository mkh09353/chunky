// sidekick — hand a brief to the persistent worker side thread. Unlike
// spawn_thread (a fresh, run-to-completion child), the sidekick is ONE standing
// thread per session on a stable thread_id: it keeps the repo context it built
// across handoffs, so a follow-up brief ("the diff has a bug in the error path —
// fix it") is cheap. Mirrors spawn_thread's shape — it finds the active run's
// ThreadManager via configurable.thread_id and delegates to delegateToSidekick.
import { tool } from "@langchain/core/tools"
import { z } from "zod"
import { threadContextFor } from "../thread-context.ts"

const DESCRIPTION = `Hand a work brief to your sidekick — a persistent worker agent (its own side thread, usually a cheaper model) that does the hands-on loop: exploring code, editing files, running builds and tests. It remembers earlier briefs this session, so follow-ups can be short ("fix the failing test in the diff you just wrote").

This is your DEFAULT way to delegate — reconnaissance as much as implementation. On a nontrivial task, make your FIRST handoff exploration: have it map the relevant code and report back file paths, key snippets, and how the pieces connect, then write your implementation brief from its report instead of reading the repo yourself. Write briefs like specs, not like code: state the goal, enumerate the constraints and edge cases explicitly (a constraint you don't write down will not survive the handoff), and define done. Don't dictate the implementation line by line — specify outcomes and let it work.

After it reports back, review with git diff/git show — do NOT pull its files into your context or rewrite its work yourself. If the work is wrong, hand back a follow-up brief with specific feedback instead of fixing it at lead prices.

The rhythm on a typical task: recon handoff → review its report and write ONE spec-quality brief → it implements + tests → you review the diff and hand back feedback if needed → commit. The best runs are the ones where you never open a repo file yourself.

NAMED SEATS: the user may configure domain seats (e.g. "backend", "frontend"), each a SEPARATE persistent worker on its own model — pass seat to route a brief to one; omit it for the default seat. Route by domain, and keep each domain's follow-ups on the same seat (that's where its context lives). Independent briefs to two different seats may be sent in the same turn to run concurrently. When you parallelize across seats, write the shared contract (endpoints, types, events) VERBATIM into both briefs — each seat sees only its own brief — then send one final integration brief to a single seat to marry the halves.

Skip the sidekick when the task isn't separable: quick answers, single-line fixes, or serial debugging where your accumulated context IS the work.`

export const sidekickInputShape = {
  task: z.string().describe("The goal: what to build/change/investigate and why, in plain language."),
  seat: z
    .string()
    .optional()
    .describe(
      'Optional NAMED seat to hand this brief to (e.g. "backend", "frontend") when the user has configured domain ' +
        "seats — each seat is its own persistent worker. Omit for the default seat. An unknown name errors with the " +
        "configured list.",
    ),
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
  seat?: string
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
    return ctx.delegateToSidekick({ callerThreadId, brief: composeBrief(input), seat: input.seat })
  },
  {
    name: "sidekick",
    description: DESCRIPTION,
    schema: z.object(sidekickInputShape),
  },
)
