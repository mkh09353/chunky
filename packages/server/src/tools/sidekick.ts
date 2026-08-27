// sidekick — hand a brief to the persistent worker side thread. Unlike
// spawn_thread (a fresh, run-to-completion child), the sidekick is ONE standing
// thread per session on a stable thread_id: it keeps the repo context it built
// across handoffs, so a follow-up brief ("the diff has a bug in the error path —
// fix it") is cheap. Mirrors spawn_thread's shape — it finds the active run's
// ThreadManager via configurable.thread_id and delegates to delegateToSidekick.
import { tool } from "@langchain/core/tools"
import { z } from "zod"
import { threadContextFor } from "../thread-context.ts"

const DESCRIPTION = `Hand a spec-quality work brief to a persistent worker agent that explores code, edits files, and runs builds/tests. It remembers earlier briefs on the same seat, so send follow-up fixes there. Use sidekick as the default delegation path for reconnaissance and implementation: for nontrivial work, first ask it to map relevant paths, snippets, and connections; then give a goal, explicit constraints/edge cases, pointers, and a hard done_when verification gate. Split briefs with 3+ separable deliverables into sequential handoffs. Review its report/diff and return specific feedback instead of redoing its work.

NAMED SEATS: each configured seat (for example backend or frontend) is a separate persistent worker/model. Pass seat to route by domain; omit it for the default. Keep all follow-ups on that same seat because its context lives there. A seat can run only one brief at a time. Different seats may run independent briefs concurrently.

DETACH: set detach=true ONLY when sending 2+ independent briefs to DIFFERENT seats in the same turn; otherwise remain synchronous. Detached reports arrive later as wake/reminders. When splitting related work across seats, repeat the shared contract (endpoints, types, events) verbatim in every brief because seats cannot see one another's briefs, then send one integration brief to a single seat.

Skip sidekick for quick answers, single-line fixes, and serial debugging where your accumulated context is the work. Point to files rather than pasting them; specify outcomes rather than line-by-line implementation.`
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
  detach: z
    .boolean()
    .optional()
    .describe(
      "Run concurrently and return immediately with a run id; the report arrives later as a wake/reminder. " +
        "Set true ONLY when sending 2+ independent briefs to DIFFERENT seats in the same turn; otherwise stay synchronous.",
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
  detach?: boolean
  constraints?: string[]
  done_when?: string
  pointers?: string
}

/** Standing conduct clause appended to every sidekick brief: keep working through
 *  blockers instead of bouncing back to the lead, but never at the cost of the
 *  brief's constraints, and never silently. */
export const PERSISTENCE_CLAUSE =
  "Persistence: if a step is blocked, attempt at least two workarounds before setting it aside, and continue with the remaining steps rather than stopping to report. Workarounds must stay within the constraints above — a constraint-violating workaround is worse than a blocked step. In your final report, list every blocker you hit and what you tried; do not paper over failures or claim unverified work as verified."

/** Assemble the structured fields into the one plain-language brief the sidekick
 *  receives. Exported for tests. */
export function composeBrief(input: SidekickInput): string {
  const parts = [input.task]
  if (input.constraints?.length) parts.push(`Constraints:\n${input.constraints.map((c) => `- ${c}`).join("\n")}`)
  if (input.done_when) parts.push(`Done when: ${input.done_when}`)
  if (input.pointers) parts.push(`Where to look:\n${input.pointers}`)
  parts.push(PERSISTENCE_CLAUSE)
  return parts.join("\n\n")
}

export const sidekick = tool(
  async (input: SidekickInput, config?: unknown) => {
    const callerThreadId = (config as any)?.configurable?.thread_id as string | undefined
    const ctx = threadContextFor(callerThreadId)
    if (!ctx || !callerThreadId) {
      return "error: sidekick is only available inside an active session run."
    }
    const title = input.seat && input.seat !== "default" ? `Sidekick (${input.seat})` : "Sidekick"
    const briefStruct = {
      task: input.task,
      ...(input.constraints ? { constraints: input.constraints } : {}),
      ...(input.done_when ? { done_when: input.done_when } : {}),
      ...(input.pointers ? { pointers: input.pointers } : {}),
      ...(input.seat ? { seat: input.seat } : {}),
    }
    const startWork = () => ctx.delegateToSidekick({ callerThreadId, brief: composeBrief(input), seat: input.seat, briefStruct })
    const text = await (ctx.runSteerDetachable?.("sidekick", title, startWork, { detach: input.detach, seat: input.seat }) ?? startWork())
    return text // ThreadManager appends the durable delegation marker.
  },
  {
    name: "sidekick",
    description: DESCRIPTION,
    schema: z.object(sidekickInputShape),
  },
)
