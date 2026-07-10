// Deterministic advisor test: inject a fake advisor-agent stream, call
// consultAdvisor(...) directly (NO model or credentials), and prove the advisor
// runs as a PERSISTENT side thread — a STABLE thread_id across consults (the whole
// point: continuity via the checkpointer) — with every event tagged
// `${rootId}:advisor`, returning the advisor's final text. Also checks advisorFor's
// auto-suppress and that the executor toolset gains/loses the `advisor` tool.
//
// Run:  bun run packages/server/src/advisor.test.ts
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Isolate settings.json writes to a throwaway file. Set before the first
// loadSettings() (none of the imports below read settings eagerly, and this runs
// after the hoisted imports but before main()).
process.env.CHUNKY_SETTINGS = join(mkdtempSync(join(tmpdir(), "chunky-advisor-")), "settings.json")

import type { AgentEvent } from "@chunky/protocol"
import { executorToolsFor } from "./agent.ts"
import { advisorFor, resolveAdvisorSelection, type AgentSelection } from "./providers/registry.ts"
import { setAdvisor } from "./settings.ts"
import { type AgentForSelection, ThreadManager } from "./threads.ts"

const events: AgentEvent[] = []
const emit = (ev: AgentEvent) => {
  events.push(ev)
  // Live proof, one JSON per line.
  console.log(JSON.stringify(ev))
}

const ROOT = "sess-advisor-deterministic"
const EXECUTOR: AgentSelection = Object.freeze({ provider: "zen", model: "glm-5.2", effort: "medium" })
// A registered provider/model that DIFFERS from the executor (so it isn't suppressed).
const SAME_AS_ADVISOR: AgentSelection = Object.freeze({ provider: "codex", model: "gpt-5.5" })

// Records every thread_id the advisor agent is streamed on plus the selection it
// was built for; returns a canned tagged stream (mirrors threads.test.ts).
const advisorThreadIds: string[] = []
const advisorSelectionsUsed: AgentSelection[] = []
const fakeAdvisorAgentFor: AgentForSelection = (selection) => {
  advisorSelectionsUsed.push(selection)
  return {
    async stream(_input, config) {
      const threadId = (config as any)?.configurable?.thread_id as string
      advisorThreadIds.push(threadId)
      return (async function* () {
        yield [
          "messages",
          [{ type: "ai", content: `Advisor guidance from ${selection.provider}/${selection.model}.` }],
        ]
      })()
    },
  }
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`)
}

async function main() {
  console.log("--- configuring advisor (codex/gpt-5.5, != executor zen/glm-5.2) ---")
  setAdvisor({ enabled: true, provider: "codex", model: "gpt-5.5" })
  const resolved = resolveAdvisorSelection()
  assert(resolved != null, "resolveAdvisorSelection() should be non-null once configured")
  console.log(`ok  advisor resolves: ${resolved!.provider}/${resolved!.model}`)

  // (4) advisorFor auto-suppress rule.
  assert(advisorFor(EXECUTOR) != null, "advisorFor(different executor) should be non-null")
  assert(advisorFor(SAME_AS_ADVISOR) === null, "advisorFor(executor == advisor) should be null (auto-suppress)")
  console.log("ok  advisorFor: non-null for a different executor, null when equal (auto-suppress)")

  // buildAgent toolset gating, via the testable helper (no model built).
  const withAdvisor = executorToolsFor(EXECUTOR)
  assert(
    withAdvisor.hasAdvisor === true && withAdvisor.tools.some((t) => (t as any).name === "advisor"),
    "executor toolset must include `advisor` when configured-and-different",
  )
  const suppressed = executorToolsFor(SAME_AS_ADVISOR)
  assert(
    suppressed.hasAdvisor === false && !suppressed.tools.some((t) => (t as any).name === "advisor"),
    "executor toolset must omit `advisor` when advisor == executor",
  )
  console.log("ok  buildAgent toolset includes `advisor` iff configured-and-different")

  console.log("\n--- two consults on the same ThreadManager ---")
  // Leave agentFor at its default (getAgent, never invoked here); inject only the
  // fake advisor agent.
  const manager = new ThreadManager(emit, ROOT, EXECUTOR, undefined, fakeAdvisorAgentFor)
  const first = await manager.consultAdvisor({
    callerThreadId: ROOT,
    question: "Is this retry loop correct?",
    pointers: "src/net.ts around line 80",
  })
  const second = await manager.consultAdvisor({
    callerThreadId: ROOT,
    question: "Follow-up: what about the backoff?",
  })
  manager.dispose()

  console.log("\n--- assertions ---")
  const expectedId = `${ROOT}:advisor`

  // (3) consultAdvisor returns the fake advisor's final text.
  assert(first.includes("Advisor guidance from codex/gpt-5.5"), "consult #1 should return the advisor's final text")
  assert(second.includes("Advisor guidance from codex/gpt-5.5"), "consult #2 should return the advisor's final text")
  console.log(`ok  consultAdvisor returned advisor text: "${first}"`)

  // (2) STABLE thread id — identical across both consults (the continuity guarantee).
  assert(advisorThreadIds.length === 2, `advisor agent should have streamed twice, got ${advisorThreadIds.length}`)
  assert(
    advisorThreadIds[0] === expectedId && advisorThreadIds[1] === expectedId,
    `advisor thread_id must be STABLE '${expectedId}' across both consults, got ${JSON.stringify(advisorThreadIds)}`,
  )
  console.log(`ok  advisor thread_id STABLE across both consults: ${expectedId}`)

  // (1) All advisor events tagged `${rootId}:advisor`.
  const spawns = events.filter((e): e is Extract<AgentEvent, { type: "thread.spawn" }> => e.type === "thread.spawn")
  assert(
    spawns.length === 2 && spawns.every((e) => e.threadId === expectedId && e.parentThreadId === null),
    "both thread.spawn events tagged with the advisor thread id (parentThreadId=null)",
  )
  const statuses = events.filter((e) => e.type === "thread.status")
  assert(
    statuses.length > 0 && statuses.every((e) => (e as any).threadId === expectedId),
    "all thread.status events tagged with the advisor thread id",
  )
  const msgs = events.filter(
    (e) => e.type === "message.start" || e.type === "message.delta" || e.type === "message.end",
  )
  assert(
    msgs.length > 0 && msgs.every((e) => (e as any).threadId === expectedId),
    "all advisor message.* events tagged with the advisor thread id",
  )
  console.log(`ok  advisor events (thread.spawn x2, thread.status, message.*) all tagged ${expectedId}`)

  // The advisor agent was built on the advisor selection, not the executor's.
  assert(
    advisorSelectionsUsed.every((s) => s.provider === "codex" && s.model === "gpt-5.5"),
    "advisor agent must be built on the advisor selection (codex/gpt-5.5)",
  )
  console.log("ok  advisor agent built on the advisor selection (codex/gpt-5.5), not the executor")

  console.log("\nPASS: deterministic advisor test")
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
