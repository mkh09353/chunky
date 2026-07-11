// Goal-mode tools. Bound on every executor but only meaningful when the session
// has an active goal (set via `/goal`). They resolve the ROOT session from the
// calling thread — like spawn_thread, the caller's thread_id arrives in the tool
// config, and the thread registry maps it back to the session — so a goal_complete
// from inside a spawned child still finishes the session's goal.
//
// The continuation LOOP lives in run.ts; these tools only mutate goal state. When
// goal_complete / goal_blocked flip the status off "active", the loop sees it after
// the turn and stops (emitting the terminal goal.update the user sees).
import { tool } from "@langchain/core/tools"
import { z } from "zod"
import { Store } from "../store.ts"
import { sessionForThread } from "../thread-context.ts"
import { toSnapshot } from "../goal.ts"

function threadIdOf(config: unknown): string | undefined {
  return (config as any)?.configurable?.thread_id as string | undefined
}

/** get_goal — read the session's current goal, so the model can re-check the
 *  objective and remaining turn budget mid-run. */
export const getGoalInputShape = {}
export const getGoalTool = tool(
  async (_input: Record<string, never>, config?: unknown) => {
    const sessionId = sessionForThread(threadIdOf(config))
    if (!sessionId) return "error: get_goal is only available inside an active session run."
    const goal = Store.getGoal(sessionId)
    if (!goal) return "No goal is set for this session."
    const snap = toSnapshot(goal)
    const extra =
      goal.status === "complete" && goal.evidence
        ? `\nEvidence: ${goal.evidence}`
        : goal.status === "blocked" && goal.blockedReason
          ? `\nBlocker: ${goal.blockedReason}`
          : ""
    return `Goal (${snap.status}, continuation turn ${snap.turns}/${snap.maxTurns}):\n${snap.objective}${extra}`
  },
  {
    name: "get_goal",
    description:
      "Read the current session goal set via /goal — its objective, status, and how many auto-continuation turns " +
      "remain. Returns a note if no goal is set.",
    schema: z.object(getGoalInputShape),
  },
)

/** goal_complete — mark the session's goal done, with evidence. Terminal: stops
 *  the continuation loop. */
export const goalCompleteInputShape = {
  summary: z
    .string()
    .describe(
      "Concise evidence that the goal is fully done and verified — what was accomplished and how you confirmed it " +
        "(tests run, output checked, files changed). Do not claim completion you haven't verified.",
    ),
}
export const goalCompleteTool = tool(
  async ({ summary }: { summary: string }, config?: unknown) => {
    const sessionId = sessionForThread(threadIdOf(config))
    if (!sessionId) return "error: goal_complete is only available inside an active session run."
    const goal = Store.getGoal(sessionId)
    if (!goal) return "error: there is no active goal to complete."
    if (goal.status === "complete") return "The goal is already marked complete."
    Store.updateGoal(sessionId, { status: "complete", evidence: summary })
    return "Goal marked complete. The continuation loop will stop after this turn."
  },
  {
    name: "goal_complete",
    description:
      "Mark the current session goal as fully complete, with a short evidence summary. Call this ONLY when the goal " +
      "is genuinely done and verified — it stops goal mode's auto-continuation. Has no effect if no goal is active.",
    schema: z.object(goalCompleteInputShape),
  },
)

/** goal_blocked — report a genuine impasse that needs the user. Terminal: stops
 *  the loop and pauses the goal. */
export const goalBlockedInputShape = {
  reason: z
    .string()
    .describe(
      "The specific blocker: what you cannot do and why it needs the user or an external action (missing credential, " +
        "ambiguous requirement, failing dependency you can't fix). Be concrete so the user can unblock you.",
    ),
}
export const goalBlockedTool = tool(
  async ({ reason }: { reason: string }, config?: unknown) => {
    const sessionId = sessionForThread(threadIdOf(config))
    if (!sessionId) return "error: goal_blocked is only available inside an active session run."
    const goal = Store.getGoal(sessionId)
    if (!goal) return "error: there is no active goal to block."
    Store.updateGoal(sessionId, { status: "blocked", blockedReason: reason })
    return "Goal marked blocked. The continuation loop will stop; the user has been shown the blocker."
  },
  {
    name: "goal_blocked",
    description:
      "Report that the current session goal is blocked and genuinely needs the user or an external action. Call this " +
      "ONLY for a real impasse — not for routine uncertainty. It stops goal mode's auto-continuation.",
    schema: z.object(goalBlockedInputShape),
  },
)

/** All goal tools, in the order they're bound onto executors. */
export const goalTools = [getGoalTool, goalCompleteTool, goalBlockedTool]
