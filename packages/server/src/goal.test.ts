// Deterministic goal-mode test — no model, no credentials. Covers the four pieces
// that make goal mode correct:
//   1. decideGoalStep — the pure continuation decision for every goal state.
//   2. parseGoalCommand — how the TUI's `/goal ...` argument string maps to intent.
//   3. Store goal persistence — put / get / update / clear roundtrips.
//   4. The goal tools — resolving the session from the caller thread (root AND a
//      spawned child) and flipping goal status so the run.ts loop will stop.
//
// Run:  bun run packages/server/src/goal.test.ts
import { rmSync } from "node:fs"

// Point the Store at a throwaway db BEFORE anything opens it, then dynamic-import
// everything so the temp path is picked up (store.ts reads CHUNKY_DB at load).
const DB = "/tmp/chunky-goal-test.db"
process.env.CHUNKY_DB = DB
for (const suffix of ["", "-wal", "-shm"]) {
  try {
    rmSync(DB + suffix)
  } catch {
    /* not there yet */
  }
}

const { decideGoalStep, parseGoalCommand, DEFAULT_MAX_TURNS } = await import("./goal.ts")
const { Store } = await import("./store.ts")
const { registerThread } = await import("./thread-context.ts")
const { getGoalTool, goalCompleteTool, goalBlockedTool } = await import("./tools/goal.ts")
type Goal = import("./goal.ts").Goal

function assert(cond: unknown, label: string): void {
  if (!cond) throw new Error(`FAIL: ${label}`)
  console.log(`ok  ${label}`)
}

function makeGoal(over: Partial<Goal> = {}): Goal {
  return {
    sessionId: "s",
    objective: "ship it",
    status: "active",
    createdAt: 1,
    updatedAt: 1,
    turns: 0,
    maxTurns: 5,
    ...over,
  }
}

async function main() {
  console.log("--- 1. decideGoalStep ---")
  assert(decideGoalStep(null, false).kind === "stop", "no goal -> stop")
  assert(decideGoalStep(null, false).kind === "stop" && (decideGoalStep(null, false) as any).reason === "no-goal", "no goal -> reason no-goal")
  assert((decideGoalStep(makeGoal({ status: "complete" }), false) as any).reason === "complete", "complete -> stop complete")
  assert((decideGoalStep(makeGoal({ status: "blocked" }), false) as any).reason === "blocked", "blocked -> stop blocked")
  assert((decideGoalStep(makeGoal({ status: "paused" }), false) as any).reason === "paused", "paused -> stop paused")
  assert((decideGoalStep(makeGoal({ turns: 0 }), true) as any).reason === "aborted", "active + aborted -> stop aborted")
  assert((decideGoalStep(makeGoal({ turns: 5, maxTurns: 5 }), false) as any).reason === "budget", "active + budget spent -> stop budget")
  const cont = decideGoalStep(makeGoal({ turns: 2, maxTurns: 5 }), false)
  assert(cont.kind === "continue" && cont.nextTurn === 3, "active + budget left -> continue nextTurn=3")

  console.log("\n--- 2. parseGoalCommand ---")
  assert(parseGoalCommand("").kind === "status", "empty -> status")
  assert(parseGoalCommand("  ").kind === "status", "whitespace -> status")
  const pause = parseGoalCommand("pause")
  assert(pause.kind === "action" && pause.action === "pause", "pause -> action pause")
  assert((parseGoalCommand("resume") as any).action === "resume", "resume -> action resume")
  assert((parseGoalCommand("continue") as any).action === "resume", "continue -> action resume")
  assert((parseGoalCommand("clear") as any).action === "clear", "clear -> action clear")
  assert((parseGoalCommand("stop") as any).action === "clear", "stop -> action clear")
  const set = parseGoalCommand("build the login page")
  assert(set.kind === "set" && set.objective === "build the login page" && set.maxTurns === undefined, "plain text -> set objective, no budget")
  const setBudget = parseGoalCommand("--turns 30 refactor the parser")
  assert(setBudget.kind === "set" && (setBudget as any).maxTurns === 30 && (setBudget as any).objective === "refactor the parser", "--turns N <text> -> set with budget")

  console.log("\n--- 3. Store goal persistence ---")
  const SID = "sess-goal-test"
  assert(Store.getGoal(SID) === null, "no goal initially")
  const g = makeGoal({ sessionId: SID, objective: "make tests pass", maxTurns: DEFAULT_MAX_TURNS })
  Store.putGoal(g)
  const loaded = Store.getGoal(SID)
  assert(loaded != null && loaded.objective === "make tests pass" && loaded.status === "active", "put/get roundtrip")
  const bumped = Store.updateGoal(SID, { turns: 3 })
  assert(bumped != null && bumped.turns === 3, "updateGoal patches turns")
  assert(Store.getGoal(SID)!.turns === 3, "update persisted")
  Store.putGoal({ ...g, objective: "replaced" })
  assert(Store.getGoal(SID)!.objective === "replaced" && Store.getGoal(SID)!.turns === 0, "putGoal replaces (upsert), resets turns")
  assert(Store.updateGoal("nobody", { turns: 1 }) === null, "updateGoal on missing goal -> null")

  console.log("\n--- 4. goal tools resolve the session and flip status ---")
  // Register a fake run context: both the root session id AND a spawned child id
  // resolve to the SAME session (as ThreadManager does), so a goal_* call from any
  // depth reaches the session goal.
  const CHILD = "child-thread-xyz"
  const fakeSpawner = {
    sessionId: SID,
    async spawn() {
      return ""
    },
    async consultAdvisor() {
      return ""
    },
  }
  registerThread(SID, fakeSpawner)
  registerThread(CHILD, fakeSpawner)

  // get_goal from the root thread reads the current objective.
  Store.putGoal(makeGoal({ sessionId: SID, objective: "green build", status: "active", turns: 0, maxTurns: DEFAULT_MAX_TURNS }))
  const read = (await getGoalTool.invoke({}, { configurable: { thread_id: SID } })) as string
  assert(read.includes("green build") && read.includes("active"), "get_goal returns objective + status")

  // goal_complete from a CHILD thread completes the session goal.
  const done = (await goalCompleteTool.invoke({ summary: "all suites pass" }, { configurable: { thread_id: CHILD } })) as string
  assert(done.toLowerCase().includes("complete"), "goal_complete returns confirmation")
  const afterComplete = Store.getGoal(SID)!
  assert(afterComplete.status === "complete" && afterComplete.evidence === "all suites pass", "goal_complete flips status + records evidence (from child thread)")
  assert(decideGoalStep(afterComplete, false).kind === "stop", "loop would STOP after goal_complete")

  // goal_blocked on a fresh active goal.
  Store.putGoal(makeGoal({ sessionId: SID, status: "active", turns: 0 }))
  const blocked = (await goalBlockedTool.invoke({ reason: "need prod credentials" }, { configurable: { thread_id: SID } })) as string
  assert(blocked.toLowerCase().includes("blocked"), "goal_blocked returns confirmation")
  assert(Store.getGoal(SID)!.status === "blocked" && Store.getGoal(SID)!.blockedReason === "need prod credentials", "goal_blocked flips status + records reason")

  // With no active run context, the tools decline gracefully.
  const orphan = (await goalCompleteTool.invoke({ summary: "x" }, { configurable: { thread_id: "unknown-thread" } })) as string
  assert(orphan.startsWith("error:"), "goal_complete outside a run -> graceful error")

  Store.clearGoal(SID)
  assert(Store.getGoal(SID) === null, "clearGoal removes the goal")

  console.log("\nPASS: deterministic goal test")
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
