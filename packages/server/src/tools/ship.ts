// ship_goal — hand the current conversation's plan off to a FRESH goal session.
// The dirty, context-heavy session distills a handoff brief (usually prompted by
// the /shipit route) and calls this tool, which: creates a new session in the
// same workspace, pins it to the orchestrator model (the advisor when one is
// configured — the session's premium model — else the active selection), sets a
// workflows-mode goal, and starts it through the session bus. The brief arrives
// as the new session's first visible message, so opening it reads like a fresh
// thread that was briefed by a colleague.
import { randomUUID } from "node:crypto"
import { tool } from "@langchain/core/tools"
import { z } from "zod"
import { Store } from "../store.ts"
import { sessionForThread } from "../thread-context.ts"
import { busInstalled, deliverToSession, emitToSession } from "../session-bus.ts"
import { DEFAULT_MAX_TURNS, firstLine, goalKickoffPrompt, toSnapshot, type Goal } from "../goal.ts"
import { activeSelection, resolveAdvisorSelection } from "../providers/registry.ts"
import { sessionLabel } from "./sessions.ts"

function threadIdOf(config: unknown): string | undefined {
  return (config as any)?.configurable?.thread_id as string | undefined
}

/** The hidden prompt POST /ship dispatches into the DIRTY session: distill a
 *  handoff brief from everything agreed in this conversation, then ship it. */
export function shipHandoffPrompt(notes?: string): string {
  const notesBlock = notes?.trim()
    ? `\n\nThe user added these notes for the handoff — fold them in:\n<user_notes>\n${notes.trim()}\n</user_notes>`
    : ""
  return `[shipit] The user wants to hand the work agreed in THIS conversation off to a fresh goal-orchestrator session that has NONE of this conversation's context. Your job now is to write the handoff brief and ship it — not to do the work.

Write the brief as if onboarding a sharp colleague who has never seen this thread. Distill; do not transcribe. Include:
- Objective: the concrete END STATE — what must be true when the work is done.
- Decisions already made, each with its one-line why; constraints; and approaches explicitly ruled out (so they aren't re-litigated).
- Pointers: exact file paths, functions, commands, docs, and any prior art discovered in this conversation.
- Verification: the concrete checks that prove completion (tests to run, commands whose output to confirm, behaviors to observe).
Leave out conversational history, dead ends (unless ruled-out-for-a-reason), and open musings the user didn't endorse.${notesBlock}

Then call ship_goal with a short title and the brief as the objective. Do not start the work yourself, and do not ask for confirmation — ship it.`
}

export interface ShipGoalInput {
  title: string
  objective: string
  max_turns?: number
}

export const shipGoalInputShape = {
  title: z.string().describe("Short title for the new session (shown in session lists), e.g. 'Ship relay reconnect'."),
  objective: z
    .string()
    .describe(
      "The full handoff brief the fresh orchestrator will work from — end state, decisions with their why, " +
        "constraints, exact file/command pointers, and concrete verification checks. It has NO other context.",
    ),
  max_turns: z
    .number()
    .optional()
    .describe("Optional cap on the goal's auto-continuation turns. Omit unless the user asked for a budget."),
}

export async function runShipGoal(input: ShipGoalInput, callerThreadId: string | undefined): Promise<string> {
  const fromSessionId = sessionForThread(callerThreadId)
  if (!fromSessionId) return "error: ship_goal is only available inside an active session run."
  if (!busInstalled()) return "error: shipping is not available in this run (no session bus)."

  const title = input.title.trim().slice(0, 80) || "Shipped goal"
  const objective = input.objective.trim()
  if (!objective) return "error: empty objective — write the handoff brief first."
  if (objective.length < 200) {
    return `error: the objective is only ${objective.length} chars — that is a task line, not a handoff brief. Include the end state, decisions made (with why), constraints, exact file/command pointers, and verification checks, then call ship_goal again.`
  }

  const maxTurns =
    typeof input.max_turns === "number" && Number.isFinite(input.max_turns) && input.max_turns > 0
      ? Math.floor(input.max_turns)
      : DEFAULT_MAX_TURNS

  // The new session lives in the same repo and is pinned to the ORCHESTRATOR
  // model: the advisor (the configured premium model) when set, else the current
  // active selection. Workflow tiers inside it still resolve small/medium to the
  // global default executor, so orchestration stays on the strong model while
  // fan-out work runs on the everyday one.
  const workspace = Store.workspaceOf(fromSessionId) ?? undefined
  const orchestrator = resolveAdvisorSelection() ?? activeSelection()
  const newSessionId = randomUUID()
  Store.createSession(newSessionId, title, workspace)
  Store.pinSelection(newSessionId, orchestrator)

  const now = Date.now()
  const goal: Goal = {
    sessionId: newSessionId,
    objective,
    status: "active",
    mode: "workflows",
    createdAt: now,
    updatedAt: now,
    turns: 0,
    maxTurns,
  }
  Store.putGoal(goal)
  emitToSession(newSessionId, {
    type: "goal.update",
    sessionId: newSessionId,
    goal: toSnapshot(goal),
    message: `◎ Goal set (orchestrator) — ${firstLine(goal.objective)}`,
  })

  // Deliver through the bus: the brief shows as the new session's first visible
  // message (with provenance), while the model actually receives the full
  // workflows-mode kickoff prompt wrapping that same objective.
  const fromLabel = `shipped from ${sessionLabel(fromSessionId, Store.titleOf(fromSessionId))}`
  try {
    deliverToSession(newSessionId, { prompt: goalKickoffPrompt(goal), shown: objective, from: fromLabel })
  } catch (err) {
    return `error: created session ${newSessionId.slice(0, 8)} with the goal, but could not start it: ${(err as Error).message}`
  }

  const model = orchestrator.model ? `${orchestrator.model} (${orchestrator.provider})` : orchestrator.provider
  return `Shipped. New session ${newSessionId.slice(0, 8)} "${title}" is running a workflows-mode goal (budget ${maxTurns} turns) with ${model} as the orchestrator; sub-agent fan-out uses the default executor model. The handoff brief is its first message — the user can open it from the sessions list. This conversation is no longer needed for that work.`
}

export const shipGoal = tool(
  async (input: ShipGoalInput, config?: unknown) => runShipGoal(input, threadIdOf(config)),
  {
    name: "ship_goal",
    description:
      "Hand the work agreed in THIS conversation off to a fresh, context-clean goal session: creates a new session " +
      "in the same repo, pins it to the orchestrator model (the advisor when configured), sets a workflows-mode " +
      "goal with your handoff brief as the objective, and starts it working autonomously. Call it with a distilled " +
      "brief (end state, decisions + why, constraints, exact pointers, verification checks) — the new session has " +
      "no other context. Use when the user says to ship/hand off the plan; do not also start the work here.",
    schema: z.object(shipGoalInputShape),
  },
)
