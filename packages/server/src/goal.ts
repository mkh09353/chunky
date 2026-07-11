// Goal mode — the domain layer. A "goal" is a session-scoped objective the agent
// works toward autonomously: after each turn that ends WITHOUT the goal being
// declared complete or blocked, the server injects a hidden continuation nudge
// and runs another turn, until the model calls goal_complete / goal_blocked or a
// turn budget is hit. This module holds the pure pieces (types, prompt builders,
// the continuation decision); persistence lives in store.ts and the loop in
// run.ts, so all three stay independently testable.
import type { GoalSnapshot, GoalStatus } from "@chunky/protocol"

export type { GoalSnapshot, GoalStatus } from "@chunky/protocol"

/** The stored goal for one session (a superset of the wire GoalSnapshot). */
export interface Goal {
  sessionId: string
  objective: string
  status: GoalStatus
  createdAt: number
  updatedAt: number
  /** Auto-continuation turns spent this run (reset to 0 on set/resume). */
  turns: number
  /** Cap on auto-continuation turns before the goal pauses itself. */
  maxTurns: number
  /** goal_complete evidence summary (terminal). */
  evidence?: string
  /** goal_blocked reason (terminal for now — user must re-goal / resume). */
  blockedReason?: string
}

/** Default continuation-turn budget. A safety backstop, not a work target: the
 *  agent normally finishes and calls goal_complete long before this. Override
 *  per-goal with `/goal --turns N ...` or CHUNKY_GOAL_MAX_TURNS. */
export const DEFAULT_MAX_TURNS = Number(process.env.CHUNKY_GOAL_MAX_TURNS) || 20

/** Project the stored goal onto the wire snapshot the TUI renders. */
export function toSnapshot(goal: Goal): GoalSnapshot {
  return { objective: goal.objective, status: goal.status, turns: goal.turns, maxTurns: goal.maxTurns }
}

/** First line of a possibly-multiline note, trimmed for a one-line transcript marker. */
export function firstLine(s: string): string {
  const line = (s.split("\n")[0] ?? "").trim()
  return line.length > 120 ? line.slice(0, 119) + "…" : line
}

/** The kickoff prompt injected when a goal is set or resumed. Not shown as a user
 *  bubble in the TUI (the server never emits user messages) — the user only sees
 *  the agent's resulting work, so this reads as an autonomous run. */
export function goalKickoffPrompt(goal: Goal): string {
  return `[goal mode] Work autonomously toward this goal until it is fully complete and verified:

${goal.objective}

Do the work directly — read, search, edit, run, and verify. You have up to ${goal.maxTurns} continuation turns; don't stall waiting for the user. When the goal is fully done AND you have verified it (tests pass, output confirmed, etc.), call goal_complete with a concise evidence summary. If you hit a genuine blocker that truly needs the user or something you cannot do, call goal_blocked with the specific reason. Start now.`
}

/** The hidden nudge injected before each auto-continuation turn. */
export function goalContinuationPrompt(goal: Goal): string {
  return `[goal mode] The goal is NOT yet complete. Keep working toward it:

${goal.objective}

This is continuation turn ${goal.turns} of ${goal.maxTurns}. Continue now — do not ask the user for confirmation, just proceed. When it is fully done and verified, call goal_complete with a concise evidence summary. If you are genuinely blocked and need the user, call goal_blocked with the specific reason.`
}

/** The outcome of one turn, from the loop's point of view. `continue` carries the
 *  turn counter to persist before the next nudge; `stop` carries why. */
export type GoalStep =
  | { kind: "continue"; nextTurn: number }
  | { kind: "stop"; reason: "no-goal" | "complete" | "blocked" | "paused" | "aborted" | "budget" }

/**
 * Decide what to do after a turn ends. Pure so run.ts's loop is trivial and the
 * branching is unit-testable without a live model:
 * - no goal / terminal status (complete, blocked, paused) → stop with that reason
 * - active but the run was interrupted → stop "aborted" (the loop pauses the goal)
 * - active but the turn budget is spent → stop "budget" (the loop pauses the goal)
 * - active with budget left → continue on the next turn number
 */
export function decideGoalStep(goal: Goal | null, aborted: boolean): GoalStep {
  if (!goal) return { kind: "stop", reason: "no-goal" }
  if (goal.status === "complete") return { kind: "stop", reason: "complete" }
  if (goal.status === "blocked") return { kind: "stop", reason: "blocked" }
  if (goal.status === "paused") return { kind: "stop", reason: "paused" }
  // status === "active"
  if (aborted) return { kind: "stop", reason: "aborted" }
  if (goal.turns >= goal.maxTurns) return { kind: "stop", reason: "budget" }
  return { kind: "continue", nextTurn: goal.turns + 1 }
}

/** Parse the argument string of the `/goal` TUI command into an intent. Supports
 *  `pause` / `resume` / `clear` / `stop`, an optional leading `--turns N`, and
 *  otherwise treats the rest as the objective text. Bare "" → status query. */
export function parseGoalCommand(
  rest: string,
): { kind: "status" } | { kind: "action"; action: "pause" | "resume" | "clear" } | { kind: "set"; objective: string; maxTurns?: number } {
  const trimmed = rest.trim()
  if (!trimmed) return { kind: "status" }
  const lower = trimmed.toLowerCase()
  if (lower === "pause") return { kind: "action", action: "pause" }
  if (lower === "resume" || lower === "continue") return { kind: "action", action: "resume" }
  if (lower === "clear" || lower === "stop" || lower === "cancel") return { kind: "action", action: "clear" }

  let objective = trimmed
  let maxTurns: number | undefined
  const m = objective.match(/^--turns\s+(\d+)\s+([\s\S]+)$/)
  if (m) {
    maxTurns = Number(m[1])
    objective = m[2]!.trim()
  }
  return { kind: "set", objective, maxTurns }
}
