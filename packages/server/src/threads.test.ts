// Deterministic ThreadManager test: call spawn(...) directly (NOT relying on the
// model choosing to call spawn_thread) and assert it emits, in order:
//   thread.spawn -> thread.status running -> child message.* tagged with the
//   child's threadId -> thread.status idle, and returns the child's final text.
//
// Run:  bun run packages/server/src/threads.test.ts
import type { AgentEvent } from "@mc/protocol"
import { ThreadManager } from "./threads.ts"

const events: AgentEvent[] = []
const emit = (ev: AgentEvent) => {
  events.push(ev)
  // Live proof, one JSON per line.
  console.log(JSON.stringify(ev))
}

const ROOT = "sess-deterministic"

async function main() {
  console.log("--- spawning child thread deterministically ---")
  const mgr = new ThreadManager(emit, ROOT)
  const finalText = await mgr.spawn({
    callerThreadId: ROOT,
    title: "List the current directory",
    instructions:
      "Use the ls tool to list the current directory, then reply with a one-sentence summary of what you found.",
  })
  mgr.dispose()

  console.log("\n--- assertions ---")

  const spawn = events.find((e) => e.type === "thread.spawn") as
    | Extract<AgentEvent, { type: "thread.spawn" }>
    | undefined
  if (!spawn) throw new Error("FAIL: no thread.spawn emitted")
  const childId = spawn.threadId
  if (spawn.parentThreadId !== null) throw new Error("FAIL: direct child should have parentThreadId=null")
  console.log(`ok  thread.spawn childId=${childId} parentThreadId=null title="${spawn.title}"`)

  const running = events.find((e) => e.type === "thread.status" && e.status === "running")
  if (!running) throw new Error("FAIL: no thread.status running emitted")
  console.log("ok  thread.status running")

  const childDeltas = events.filter(
    (e) => e.type === "message.delta" && (e as any).threadId === childId,
  )
  if (childDeltas.length === 0) throw new Error("FAIL: no child-tagged message.delta emitted")
  console.log(`ok  ${childDeltas.length} child-tagged message.delta (threadId=${childId})`)

  // Every message/tool event during the child run must carry the child threadId.
  const mistagged = events.filter(
    (e) =>
      (e.type === "message.start" ||
        e.type === "message.delta" ||
        e.type === "message.end" ||
        e.type === "tool.start" ||
        e.type === "tool.end") &&
      (e as any).threadId !== childId,
  )
  if (mistagged.length > 0) {
    throw new Error(`FAIL: ${mistagged.length} child events missing threadId=${childId}`)
  }
  console.log("ok  all child message/tool events tagged with the child threadId")

  const idle = events.filter((e) => e.type === "thread.status" && e.status === "idle")
  if (idle.length === 0) throw new Error("FAIL: no thread.status idle emitted")
  console.log("ok  thread.status idle")

  // Ordering: spawn before running before first delta before idle.
  const iSpawn = events.findIndex((e) => e.type === "thread.spawn")
  const iRunning = events.findIndex((e) => e.type === "thread.status" && e.status === "running")
  const iFirstDelta = events.findIndex(
    (e) => e.type === "message.delta" && (e as any).threadId === childId,
  )
  const iIdle = events.findIndex((e) => e.type === "thread.status" && e.status === "idle")
  if (!(iSpawn < iRunning && iRunning < iFirstDelta && iFirstDelta < iIdle)) {
    throw new Error(
      `FAIL: bad ordering spawn=${iSpawn} running=${iRunning} firstDelta=${iFirstDelta} idle=${iIdle}`,
    )
  }
  console.log(`ok  ordering spawn<running<delta<idle (${iSpawn}<${iRunning}<${iFirstDelta}<${iIdle})`)

  if (!finalText || finalText.trim().length === 0) {
    throw new Error("FAIL: spawn() returned empty final text")
  }
  console.log(`ok  spawn() returned final text (${finalText.length} chars)`)
  console.log(`\nCHILD FINAL TEXT:\n${finalText}\n`)

  console.log("PASS: deterministic thread test")
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
