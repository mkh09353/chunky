// Deterministic sidekick test: inject a fake sidekick-agent stream, call
// delegateToSidekick(...) directly (NO model or credentials), and prove the
// sidekick runs as a PERSISTENT worker side thread — a STABLE thread_id across
// handoffs (the whole point: the worker keeps its repo context via the
// checkpointer) — with every event tagged `${rootId}:sidekick`, returning the
// sidekick's report. Also checks sidekickFor's configured/inherit/disabled
// resolution, the executor toolset gating, and composeBrief's assembly.
//
// Run:  bun run packages/server/src/sidekick.test.ts
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Isolate settings.json writes to a throwaway file. Set before the first
// loadSettings() (none of the imports below read settings eagerly, and this runs
// after the hoisted imports but before main()).
process.env.CHUNKY_SETTINGS = join(mkdtempSync(join(tmpdir(), "chunky-sidekick-")), "settings.json")

import type { AgentEvent } from "@chunky/protocol"
import { executorToolsFor } from "./agent.ts"
import { listSidekickSeats, resolveSidekickSeat, sidekickFor, type AgentSelection } from "./providers/registry.ts"
import { currentModeSpec, isValidSeatName, setSidekick, setSidekickSeat } from "./settings.ts"
import { type AgentForSelection, ThreadManager } from "./threads.ts"
import { composeBrief } from "./tools/sidekick.ts"

const events: AgentEvent[] = []
const emit = (ev: AgentEvent) => {
  events.push(ev)
  // Live proof, one JSON per line.
  console.log(JSON.stringify(ev))
}

const ROOT = "sess-sidekick-deterministic"
const EXECUTOR: AgentSelection = Object.freeze({ provider: "zen", model: "glm-5.2", effort: "medium" })

// Records every thread_id the sidekick agent is streamed on plus the selection it
// was built for; returns a canned tagged stream (mirrors advisor.test.ts).
const sidekickThreadIds: string[] = []
const sidekickSelectionsUsed: AgentSelection[] = []
const fakeSidekickAgentFor: AgentForSelection = (selection) => {
  sidekickSelectionsUsed.push(selection)
  return {
    async stream(_input, config) {
      const threadId = (config as any)?.configurable?.thread_id as string
      sidekickThreadIds.push(threadId)
      return (async function* () {
        yield [
          "messages",
          [{ type: "ai", content: `Sidekick report from ${selection.provider}/${selection.model}.` }],
        ]
      })()
    },
  }
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`)
}

async function main() {
  console.log("--- sidekickFor resolution: inherit / configured / disabled ---")
  // Never-configured default: enabled, no seat -> inherit the executor selection.
  const inherited = sidekickFor(EXECUTOR)
  assert(
    inherited != null && inherited.provider === EXECUTOR.provider && inherited.model === EXECUTOR.model,
    "unconfigured sidekick should inherit the executor selection",
  )
  console.log(`ok  unconfigured seat inherits the executor: ${inherited!.provider}/${inherited!.model}`)

  // Configured seat: a registered provider/model that differs from the executor.
  setSidekick({ enabled: true, provider: "codex", model: "gpt-5.5", effort: "xhigh" })
  const configured = sidekickFor(EXECUTOR)
  assert(
    configured != null && configured.provider === "codex" && configured.model === "gpt-5.5" && configured.effort === "xhigh",
    "configured sidekick seat should resolve as set",
  )
  console.log(`ok  configured seat resolves: ${configured!.provider}/${configured!.model} (${configured!.effort})`)

  // NO same-model auto-suppress (unlike the advisor): context isolation still pays.
  const sameAsExecutor: AgentSelection = Object.freeze({ provider: "codex", model: "gpt-5.5" })
  assert(sidekickFor(sameAsExecutor) != null, "sidekickFor(executor == sidekick) should be non-null (no auto-suppress)")
  console.log("ok  no same-model auto-suppress")

  // Toolset gating: present while enabled, gone when disabled.
  const withSidekick = executorToolsFor(EXECUTOR)
  assert(
    withSidekick.hasSidekick === true && withSidekick.tools.some((t) => (t as any).name === "sidekick"),
    "executor toolset must include `sidekick` while enabled",
  )
  setSidekick({ enabled: false })
  assert(sidekickFor(EXECUTOR) === null, "disabled sidekick should resolve null")
  const without = executorToolsFor(EXECUTOR)
  assert(
    without.hasSidekick === false && !without.tools.some((t) => (t as any).name === "sidekick"),
    "executor toolset must omit `sidekick` when disabled",
  )
  console.log("ok  buildAgent toolset includes `sidekick` iff enabled")
  setSidekick({ enabled: true }) // re-enable for the handoff test (seat stays codex/gpt-5.5)

  console.log("\n--- composeBrief assembly ---")
  const brief = composeBrief({
    task: "Port the retry helper to src/net2.ts",
    constraints: ["keep the public signature", "operator() must be O(1): NO full token scan"],
    done_when: "vitest run passes",
    pointers: "src/net.ts:80",
  })
  assert(
    brief.includes("Port the retry helper") &&
      brief.includes("- keep the public signature") &&
      brief.includes("- operator() must be O(1): NO full token scan") &&
      brief.includes("Done when: vitest run passes") &&
      brief.includes("Where to look:\nsrc/net.ts:80"),
    "composeBrief should assemble task, constraints, done_when, and pointers",
  )
  assert(composeBrief({ task: "just this" }) === "just this", "a task-only brief should be the bare task")
  console.log("ok  composeBrief assembles the brief (and passes a bare task through)")

  console.log("\n--- two handoffs on the same ThreadManager ---")
  // Leave agentFor/advisorAgentFor at their defaults (never invoked here); inject
  // only the fake sidekick agent.
  const manager = new ThreadManager(emit, ROOT, EXECUTOR, undefined, undefined, undefined, undefined, fakeSidekickAgentFor)
  const first = await manager.delegateToSidekick({
    callerThreadId: ROOT,
    brief: "Implement the retry helper per the constraints.",
  })
  const second = await manager.delegateToSidekick({
    callerThreadId: ROOT,
    brief: "The diff misses the jitter case — fix it. Constraints still apply.",
  })
  manager.dispose()

  console.log("\n--- assertions ---")
  const expectedId = `${ROOT}:sidekick`

  // delegateToSidekick returns the fake sidekick's report.
  assert(first.includes("Sidekick report from codex/gpt-5.5"), "handoff #1 should return the sidekick's report")
  assert(second.includes("Sidekick report from codex/gpt-5.5"), "handoff #2 should return the sidekick's report")
  console.log(`ok  delegateToSidekick returned sidekick text: "${first}"`)

  // STABLE thread id — identical across both handoffs (the continuity guarantee).
  assert(sidekickThreadIds.length === 2, `sidekick agent should have streamed twice, got ${sidekickThreadIds.length}`)
  assert(
    sidekickThreadIds[0] === expectedId && sidekickThreadIds[1] === expectedId,
    `sidekick thread_id must be STABLE '${expectedId}' across both handoffs, got ${JSON.stringify(sidekickThreadIds)}`,
  )
  console.log(`ok  sidekick thread_id STABLE across both handoffs: ${expectedId}`)

  // All sidekick events tagged `${rootId}:sidekick`.
  const spawns = events.filter((e): e is Extract<AgentEvent, { type: "thread.spawn" }> => e.type === "thread.spawn")
  assert(
    spawns.length === 2 && spawns.every((e) => e.threadId === expectedId && e.parentThreadId === null),
    "both thread.spawn events tagged with the sidekick thread id (parentThreadId=null)",
  )
  const statuses = events.filter((e) => e.type === "thread.status")
  assert(
    statuses.length > 0 && statuses.every((e) => (e as any).threadId === expectedId),
    "all thread.status events tagged with the sidekick thread id",
  )
  const msgs = events.filter(
    (e) => e.type === "message.start" || e.type === "message.delta" || e.type === "message.end",
  )
  assert(
    msgs.length > 0 && msgs.every((e) => (e as any).threadId === expectedId),
    "all sidekick message.* events tagged with the sidekick thread id",
  )
  console.log(`ok  sidekick events (thread.spawn x2, thread.status, message.*) all tagged ${expectedId}`)

  // The sidekick agent was built on the configured seat, not the executor's selection.
  assert(
    sidekickSelectionsUsed.every((s) => s.provider === "codex" && s.model === "gpt-5.5"),
    "sidekick agent must be built on the configured seat (codex/gpt-5.5)",
  )
  console.log("ok  sidekick agent built on the configured seat (codex/gpt-5.5), not the executor")

  console.log("\n--- named seats: config, resolution, per-seat threads ---")
  assert(isValidSeatName("frontend") && isValidSeatName("be-2"), "slug seat names are valid")
  assert(!isValidSeatName("default") && !isValidSeatName("Front End") && !isValidSeatName(""), "reserved/uppercase/empty names rejected")

  setSidekickSeat("frontend", { provider: "zen", model: "glm-5.2", effort: "high" })
  setSidekickSeat("backend", { provider: "codex", model: "gpt-5.5", effort: "xhigh" })
  assert(JSON.stringify(listSidekickSeats()) === JSON.stringify(["backend", "frontend"]), "listSidekickSeats sorted")
  const fe = resolveSidekickSeat("frontend")
  assert(fe != null && fe.provider === "zen" && fe.model === "glm-5.2" && fe.effort === "high", "named seat resolves as configured")
  assert(resolveSidekickSeat("nope") === null, "unknown seat resolves null")

  // Mode snapshot carries the named seats.
  const snap = currentModeSpec()
  assert(
    snap.sidekickSeats != null && snap.sidekickSeats.frontend?.model === "glm-5.2" && snap.sidekickSeats.backend?.model === "gpt-5.5",
    "currentModeSpec snapshots named seats",
  )
  console.log("ok  seat config + resolution + mode snapshot")

  // Handoffs to a NAMED seat run on that seat's OWN stable thread id.
  sidekickThreadIds.length = 0
  sidekickSelectionsUsed.length = 0
  events.length = 0
  const manager2 = new ThreadManager(emit, ROOT, EXECUTOR, undefined, undefined, undefined, undefined, fakeSidekickAgentFor)
  const feReport = await manager2.delegateToSidekick({ callerThreadId: ROOT, brief: "Style the wizard.", seat: "frontend" })
  await manager2.delegateToSidekick({ callerThreadId: ROOT, brief: "Polish it.", seat: "frontend" })
  const unknown = await manager2.delegateToSidekick({ callerThreadId: ROOT, brief: "x", seat: "fronted" })
  manager2.dispose()

  assert(feReport.includes("Sidekick report from zen/glm-5.2"), "named-seat handoff runs the seat's model")
  const feId = `${ROOT}:sidekick:frontend`
  assert(
    sidekickThreadIds.length === 2 && sidekickThreadIds.every((id) => id === feId),
    `named seat must run on its OWN stable thread id '${feId}', got ${JSON.stringify(sidekickThreadIds)}`,
  )
  assert(
    sidekickSelectionsUsed.every((s) => s.provider === "zen" && s.model === "glm-5.2"),
    "named-seat agent built on the seat's selection",
  )
  const feSpawns = events.filter((e) => e.type === "thread.spawn")
  assert(
    feSpawns.length === 2 && feSpawns.every((e) => (e as any).threadId === feId && (e as any).title === "Sidekick (frontend)"),
    "named-seat events tagged with the seat thread id + titled 'Sidekick (frontend)'",
  )
  // Unknown seat: a correctable error naming the configured seats, no stream.
  assert(
    unknown.startsWith("error:") && unknown.includes('"backend"') && unknown.includes('"frontend"'),
    "unknown seat errors with the configured seat list",
  )
  console.log("ok  named-seat handoffs: own stable thread id, seat model, unknown-seat error")

  console.log("\nPASS: deterministic sidekick test")
}

// No process.exit(0) on success: under `bun test` that would kill the runner
// and silently skip every test file that runs after this one.
await main().catch((err) => {
  console.error(err)
  process.exit(1)
})
