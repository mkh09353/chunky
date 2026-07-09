// Deterministic ThreadManager test: inject a fake agent stream, call spawn(...)
// directly (NOT relying on a model or credentials), and assert it emits, in order:
//   thread.spawn -> thread.status running -> child message.* tagged with the
//   child's threadId -> thread.status idle, returns the child's final text, and
//   gives each child the intended explicit or inherited model selection,
//   including a grandchild inheriting its parent's overridden selection.
//
// Run:  bun run packages/server/src/threads.test.ts
import type { AgentEvent } from "@chunky/protocol"
import type { AgentSelection } from "./providers/registry.ts"
import { type AgentForSelection, ThreadManager } from "./threads.ts"

const events: AgentEvent[] = []
const emit = (ev: AgentEvent) => {
  events.push(ev)
  // Live proof, one JSON per line.
  console.log(JSON.stringify(ev))
}

const ROOT = "sess-deterministic"
const ROOT_SELECTION: AgentSelection = Object.freeze({
  provider: "zen",
  model: "glm-5.2",
  effort: "medium",
})
const CHILD_SELECTION = {
  provider: "codex",
  model: "gpt-5.4-codex",
  effort: "high" as const,
  speed: "fast" as const,
}
const selectionsUsed: AgentSelection[] = []
let manager: ThreadManager | undefined
let nestedSpawned = false

const fakeAgentFor: AgentForSelection = (selection) => {
  selectionsUsed.push(selection)
  return {
    async stream(_input, config) {
      return (async function* () {
        const threadId = (config as any)?.configurable?.thread_id as string | undefined
        if (selection.provider === "codex" && !nestedSpawned && threadId) {
          nestedSpawned = true
          const nestedText = await manager!.spawn({
            callerThreadId: threadId,
            title: "Inspect a nested subtask",
            instructions: "Reply with one sentence from the nested child.",
          })
          if (!nestedText.trim()) throw new Error("FAIL: nested spawn returned empty final text")
        }
        yield [
          "messages",
          [
            {
              type: "ai",
              content: `Fake child reply from ${selection.provider}/${selection.model ?? "default"}.`,
            },
          ],
        ]
      })()
    },
  }
}

function assertSelection(actual: AgentSelection, expected: AgentSelection, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`FAIL: ${label} selection ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`)
  }
}

async function main() {
  console.log("--- spawning child thread deterministically ---")
  manager = new ThreadManager(emit, ROOT, ROOT_SELECTION, fakeAgentFor)
  const finalText = await manager.spawn({
    callerThreadId: ROOT,
    title: "List the current directory",
    instructions:
      "Use the ls tool to list the current directory, then reply with a one-sentence summary of what you found.",
    selection: CHILD_SELECTION,
  })
  const inheritedFinalText = await manager.spawn({
    callerThreadId: ROOT,
    title: "Summarize the project",
    instructions: "Reply with a one-sentence project summary.",
  })
  manager.dispose()

  console.log("\n--- assertions ---")

  const spawn = events.find((e) => e.type === "thread.spawn") as
    | Extract<AgentEvent, { type: "thread.spawn" }>
    | undefined
  if (!spawn) throw new Error("FAIL: no thread.spawn emitted")
  const childId = spawn.threadId
  if (spawn.parentThreadId !== null) throw new Error("FAIL: direct child should have parentThreadId=null")
  console.log(`ok  thread.spawn childId=${childId} parentThreadId=null title="${spawn.title}"`)

  const grandchild = events.find(
    (e): e is Extract<AgentEvent, { type: "thread.spawn" }> =>
      e.type === "thread.spawn" && e.parentThreadId === childId,
  )
  if (!grandchild) throw new Error("FAIL: no nested child was spawned")
  console.log(`ok  nested child ${grandchild.threadId} inherited parent=${childId}`)

  const running = events.find((e) => e.type === "thread.status" && e.status === "running")
  if (!running) throw new Error("FAIL: no thread.status running emitted")
  console.log("ok  thread.status running")

  const childDeltas = events.filter(
    (e) => e.type === "message.delta" && (e as any).threadId === childId,
  )
  if (childDeltas.length === 0) throw new Error("FAIL: no child-tagged message.delta emitted")
  console.log(`ok  ${childDeltas.length} child-tagged message.delta (threadId=${childId})`)

  // Every message/tool event during either child run must carry that child's threadId.
  const childIds = new Set(
    events.filter((e): e is Extract<AgentEvent, { type: "thread.spawn" }> => e.type === "thread.spawn").map((e) => e.threadId),
  )
  const mistagged = events.filter(
    (e) =>
      (e.type === "message.start" ||
        e.type === "message.delta" ||
        e.type === "message.end" ||
        e.type === "tool.start" ||
        e.type === "tool.end") &&
      !childIds.has((e as any).threadId),
  )
  if (mistagged.length > 0) {
    throw new Error(`FAIL: ${mistagged.length} child events missing threadId=${childId}`)
  }
  console.log("ok  all child message/tool events tagged with their child threadId")

  const idle = events.find((e) => e.type === "thread.status" && e.threadId === childId && e.status === "idle")
  if (!idle) throw new Error("FAIL: no outer-child thread.status idle emitted")
  console.log("ok  thread.status idle")

  // Ordering: spawn before running before first delta before idle.
  const iSpawn = events.findIndex((e) => e.type === "thread.spawn")
  const iRunning = events.findIndex((e) => e.type === "thread.status" && e.status === "running")
  const iFirstDelta = events.findIndex(
    (e) => e.type === "message.delta" && (e as any).threadId === childId,
  )
  const iIdle = events.findIndex((e) => e.type === "thread.status" && e.threadId === childId && e.status === "idle")
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
  if (!inheritedFinalText || inheritedFinalText.trim().length === 0) {
    throw new Error("FAIL: inherited spawn() returned empty final text")
  }
  console.log(`ok  inherited spawn() returned final text (${inheritedFinalText.length} chars)`)

  if (selectionsUsed.length !== 3) {
    throw new Error(`FAIL: expected three selected agents, got ${selectionsUsed.length}`)
  }
  assertSelection(selectionsUsed[0]!, CHILD_SELECTION, "explicit child")
  assertSelection(selectionsUsed[1]!, CHILD_SELECTION, "nested child")
  assertSelection(selectionsUsed[2]!, ROOT_SELECTION, "inherited child")
  console.log("ok  explicit child selection used; nested child inherited it; omitted selection inherited the root model")
  console.log(`\nCHILD FINAL TEXT:\n${finalText}\n`)

  console.log("PASS: deterministic thread test")
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
