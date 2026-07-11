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
import { DEFAULT_MAX_TURNS, toSnapshot, type Goal } from "../goal.ts"

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
      "Mark the current session goal as fully complete, with a short evidence summary. Before calling, audit " +
      "completion as unproven: verify every concrete requirement of the objective against current evidence (files, " +
      "command output, test results) — the audit must prove completion, not merely fail to find remaining work. " +
      "Never call this because the turn budget is nearly spent. It stops goal mode's auto-continuation.",
    schema: z.object(goalCompleteInputShape),
  },
)

/** create_goal — let the MODEL start a goal when the user asks for autonomous
 *  work in plain language ("keep going until it's done") instead of via /goal.
 *  The run loop notices the new active goal when the turn ends and starts
 *  auto-continuing — no server route involved. */
export const createGoalInputShape = {
  objective: z
    .string()
    .describe(
      "The concrete objective to pursue autonomously. State the requested END STATE (what must be true when " +
        "done), not the first step.",
    ),
  max_turns: z
    .number()
    .optional()
    .describe("Optional cap on auto-continuation turns. Omit unless the user asked for a specific budget."),
}
export const createGoalTool = tool(
  async ({ objective, max_turns }: { objective: string; max_turns?: number }, config?: unknown) => {
    const sessionId = sessionForThread(threadIdOf(config))
    if (!sessionId) return "error: create_goal is only available inside an active session run."
    const trimmed = objective.trim()
    if (!trimmed) return "error: empty objective."
    if (trimmed.length > 4000) {
      return `error: objective too long (${trimmed.length} chars, limit 4000). Put long instructions in a file and reference it from the objective.`
    }
    const existing = Store.getGoal(sessionId)
    if (existing && existing.status !== "complete") {
      return `error: this session already has a ${existing.status} goal ("${existing.objective.slice(0, 80)}"). Finish it with goal_complete, or ask the user to run /goal clear or /goal <new objective>.`
    }
    const now = Date.now()
    const maxTurns =
      typeof max_turns === "number" && Number.isFinite(max_turns) && max_turns > 0
        ? Math.floor(max_turns)
        : DEFAULT_MAX_TURNS
    const goal: Goal = {
      sessionId,
      objective: trimmed,
      status: "active",
      createdAt: now,
      updatedAt: now,
      turns: 0,
      maxTurns,
    }
    Store.putGoal(goal)
    return `Goal created (turn budget ${maxTurns}). Start working toward it NOW — when this turn ends the server auto-continues until you call goal_complete (with verified evidence) or goal_blocked.`
  },
  {
    name: "create_goal",
    description:
      "Create a session goal so the server auto-continues your turns until it is done. Use ONLY when the user " +
      "explicitly asks for autonomous or long-running work toward an objective (e.g. 'keep going until it's done', " +
      "'work on this until tests pass') — do not infer a goal from an ordinary task. Fails if an unfinished goal " +
      "already exists.",
    schema: z.object(createGoalInputShape),
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
      "ONLY when the SAME blocking condition has repeated for at least three consecutive goal turns and you cannot " +
      "make meaningful progress — never because the work is hard, slow, or would benefit from clarification. But " +
      "once that threshold is met, call it rather than staying blocked-but-active. It stops the auto-continuation.",
    schema: z.object(goalBlockedInputShape),
  },
)

/** All goal tools, in the order they're bound onto executors. */
export const goalTools = [getGoalTool, createGoalTool, goalCompleteTool, goalBlockedTool]
