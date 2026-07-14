// Deterministic ship_goal test — no model, no credentials. Covers the handoff
// pipeline end to end minus the LLM: a fake session bus + fake thread context,
// then ship_goal must (1) refuse a task-line "brief", (2) create the new session
// in the SAME workspace, (3) pin the orchestrator selection, (4) store an active
// workflows-mode goal, (5) stamp the goal.update marker, and (6) deliver the
// workflows-mode kickoff through the bus with the brief as the visible message.
//
// Run:  bun test packages/server/src/tools/ship.test.ts
import { rmSync } from "node:fs"
import { randomUUID } from "node:crypto"

// Point the Store at a throwaway db BEFORE anything opens it, then dynamic-import
// everything so the temp path is picked up (store.ts reads CHUNKY_DB at load).
const DB = "/tmp/chunky-ship-test.db"
process.env.CHUNKY_DB = DB
for (const suffix of ["", "-wal", "-shm"]) {
  try {
    rmSync(DB + suffix)
  } catch {
    /* not there yet */
  }
}

const { Store } = await import("../store.ts")
const { registerThread, unregisterThread } = await import("../thread-context.ts")
const { installSessionBus, resetSessionBus } = await import("../session-bus.ts")
const { runShipGoal, shipHandoffPrompt } = await import("./ship.ts")
const { activeSelection, resolveAdvisorSelection } = await import("../providers/registry.ts")

function assert(cond: unknown, label: string): void {
  if (!cond) throw new Error(`FAIL: ${label}`)
  console.log(`ok  ${label}`)
}

/** A brief long enough to pass the "that's a task line, not a brief" guard. */
const BRIEF = [
  "Objective: the relay uplink reconnects with exponential backoff after a network drop, verified by the cross-repo E2E suite.",
  "Decisions: keep the outbound-only WebSocket design (no listening ports); backoff caps at 60s (user-agreed).",
  "Pointers: packages/server/src/relay/uplink.ts (startUplink), docs/relay-design.md.",
  "Verification: bun test packages/server, plus the relay E2E suite must stream events across a simulated drop.",
].join("\n")

async function main() {
  console.log("--- 1. guards ---")
  const orphan = await runShipGoal({ title: "t", objective: BRIEF }, "unknown-thread")
  assert(orphan.startsWith("error:"), "no run context -> graceful error")

  // Random id: bun test shares one module registry across files, so whichever
  // test file loads store.ts first pins the db — this file's wipe of its own
  // temp db is NOT guaranteed to apply. A fixed id would collide on re-runs.
  const FROM = `ship-from-${randomUUID()}`
  const WORKSPACE = "/tmp/chunky-ship-test-workspace"
  Store.createSession(FROM, "planning the relay fix", WORKSPACE)
  const fakeSpawner = {
    sessionId: FROM,
    async spawn() {
      return ""
    },
    async consultAdvisor() {
      return ""
    },
    async delegateToSidekick() {
      return ""
    },
    async runWorkflow() {
      return ""
    },
  }
  registerThread(FROM, fakeSpawner)

  resetSessionBus()
  const noBus = await runShipGoal({ title: "t", objective: BRIEF }, FROM)
  assert(noBus.startsWith("error:") && noBus.includes("bus"), "bus not installed -> graceful error")

  const delivered: Array<{ sessionId: string; shown: string; from: string; prompt: string }> = []
  const events: Array<{ sessionId: string; ev: any }> = []
  installSessionBus({
    emitUserMessage(sessionId, text, from) {
      delivered.push({ sessionId, shown: text, from, prompt: "" })
    },
    emitEvent(sessionId, ev) {
      events.push({ sessionId, ev })
    },
    dispatch(sessionId, text) {
      delivered[delivered.length - 1]!.prompt = text
      return Promise.resolve()
    },
    isRunning() {
      return false
    },
  })

  const short = await runShipGoal({ title: "t", objective: "fix the bug" }, FROM)
  assert(short.startsWith("error:") && short.includes("brief"), "task-line objective -> rejected, asks for a real brief")

  console.log("\n--- 2. the ship ---")
  const before = new Set(Store.list().map((s) => s.sessionId))
  const result = await runShipGoal({ title: "Ship relay reconnect", objective: BRIEF, max_turns: 12 }, FROM)
  assert(result.startsWith("Shipped."), "returns a Shipped confirmation")

  const created = Store.list().find((s) => !before.has(s.sessionId))
  assert(created != null, "a new session exists")
  const newId = created!.sessionId
  assert(result.includes(newId.slice(0, 8)), "confirmation names the new session id")
  assert(created!.title === "Ship relay reconnect", "new session carries the ship title")
  assert(Store.workspaceOf(newId) === WORKSPACE, "new session pinned to the SAME workspace as the source")

  const expected = resolveAdvisorSelection() ?? activeSelection()
  const pinned = Store.pinnedSelectionOf(newId)
  assert(pinned != null && pinned.provider === expected.provider && pinned.model === expected.model, "orchestrator selection pinned (advisor when configured, else active)")

  const goal = Store.getGoal(newId)!
  assert(goal != null && goal.status === "active", "new session has an active goal")
  assert(goal.mode === "workflows", "goal is workflows mode")
  assert(goal.objective === BRIEF && goal.maxTurns === 12, "goal carries the brief + turn budget")

  assert(events.length === 1 && events[0]!.sessionId === newId, "one goal.update stamped on the new session")
  assert(events[0]!.ev.type === "goal.update" && events[0]!.ev.goal?.mode === "workflows", "marker carries the workflows snapshot")

  assert(delivered.length === 1 && delivered[0]!.sessionId === newId, "kickoff delivered to the new session")
  assert(delivered[0]!.shown === BRIEF, "the brief is the new session's visible first message")
  assert(delivered[0]!.prompt.startsWith("[goal mode: orchestrator]"), "the model receives the workflows-mode kickoff")
  assert(delivered[0]!.prompt.includes("<untrusted_objective>"), "kickoff wraps the brief as untrusted data")
  assert(delivered[0]!.from.startsWith("shipped from"), "provenance labels the source session")
  assert(delivered[0]!.from.includes("planning the relay fix"), "provenance carries the source title")

  console.log("\n--- 3. orchestrator model override ---")
  const badProv = await runShipGoal({ title: "t", objective: BRIEF, orchestrator_provider: "not-a-provider" }, FROM)
  assert(badProv.startsWith("error:") && badProv.includes("Valid providers"), "unknown orchestrator_provider -> error listing valid ids")

  const before2 = new Set(Store.list().map((s) => s.sessionId))
  const result2 = await runShipGoal({ title: "Effort override", objective: BRIEF, orchestrator_effort: "low" }, FROM)
  assert(result2.startsWith("Shipped."), "ship with orchestrator override succeeds")
  const created2 = Store.list().find((s) => !before2.has(s.sessionId))!
  const pinned2 = Store.pinnedSelectionOf(created2.sessionId)
  assert(pinned2 != null && pinned2.effort === "low", "explicit orchestrator_effort is pinned on the new session")
  assert(pinned2!.provider === expected.provider, "provider still defaults to advisor/active when not overridden")
  Store.clearGoal(created2.sessionId)

  console.log("\n--- 4. handoff prompt ---")
  const plain = shipHandoffPrompt()
  assert(plain.startsWith("[shipit]") && plain.includes("ship_goal"), "handoff prompt instructs a brief + ship_goal call")
  assert(!plain.includes("<user_notes>"), "no notes -> no notes block")
  const noted = shipHandoffPrompt("skip the app UI for now")
  assert(noted.includes("<user_notes>") && noted.includes("skip the app UI for now"), "notes folded into the brief instructions")

  // Cleanup so reruns against a shared db stay deterministic.
  Store.clearGoal(newId)
  unregisterThread(FROM)
  resetSessionBus()

  console.log("\nPASS: deterministic ship test")
}

// No process.exit(0) on success: under `bun test` that would kill the runner
// and silently skip every test file that runs after this one.
await main().catch((err) => {
  console.error(err)
  process.exit(1)
})
