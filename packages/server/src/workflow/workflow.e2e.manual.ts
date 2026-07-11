// Live end-to-end (needs real Zen creds in .env): drive ThreadManager.runWorkflow
// with a REAL agent factory so a dynamic-workflow actually fans out real child
// agents on glm-5.2, runs them under the concurrency cap, and synthesizes. Proves
// the whole server-side path minus HTTP/TUI: workflow.* events, multiple real
// thread.spawn children, concurrent checkpointer writes (WAL), and a final answer.
//
// Run:  bun run packages/server/src/workflow/workflow.e2e.manual.ts
import type { AgentEvent } from "@chunky/protocol"
import { ThreadManager } from "../threads.ts"
import type { AgentSelection } from "../providers/registry.ts"

const events: AgentEvent[] = []
const spawns: string[] = []
const emit = (ev: AgentEvent) => {
  events.push(ev)
  if (ev.type === "thread.spawn") {
    spawns.push(ev.threadId)
    console.log(`  >> thread.spawn "${ev.title}" (${ev.threadId.slice(0, 8)})`)
  } else if (ev.type === "workflow.phase") {
    console.log(`  ◆ phase: ${ev.title}`)
  } else if (ev.type === "workflow.log") {
    console.log(`  · ${ev.message}`)
  } else if (ev.type === "error") {
    console.log(`  ✗ error: ${ev.message}`)
  }
}

const rootId = "wf-e2e-root"
const selection: AgentSelection = Object.freeze({ provider: "zen", model: "glm-5.2", effort: "low" })
const mgr = new ThreadManager(emit, rootId, selection)

// A tiny fan-out: two parallel word-agents, then a synthesis agent. 3 real children.
const script = `
phase('Gather')
log('spawning two word agents in parallel')
const words = await parallel([
  () => agent('Reply with exactly one lowercase word and nothing else: apple', { label: 'w1' }),
  () => agent('Reply with exactly one lowercase word and nothing else: banana', { label: 'w2' }),
])
phase('Synthesize')
return await agent('Return ONLY a comma-separated list (no other text) of these two words: ' + words.join(' '), { label: 'combine' })
`

console.log("running workflow…")
const started = performance.now()
const result = await mgr.runWorkflow({ callerThreadId: rootId, script })
const ms = Math.round(performance.now() - started)
mgr.dispose()

console.log("\n--- RESULT ---\n" + result)

// Assertions.
const fail = (m: string) => {
  console.error("FAIL: " + m)
  process.exit(1)
}
const phases = events.filter((e) => e.type === "workflow.phase").length
const logs = events.filter((e) => e.type === "workflow.log").length
if (spawns.length < 3) fail(`expected >=3 child spawns, got ${spawns.length}`)
if (phases < 2) fail(`expected >=2 workflow.phase events, got ${phases}`)
if (logs < 2) fail(`expected workflow start/finish logs, got ${logs}`)
const lower = result.toLowerCase()
if (!lower.includes("apple") || !lower.includes("banana")) fail("synthesis missing apple/banana — fan-out results didn't reach the final agent")

console.log(`\nok  ${spawns.length} real child threads, ${phases} phases, ${logs} logs, synthesized in ${ms}ms`)
console.log("PASS: live workflow fan-out end-to-end")
process.exit(0)
