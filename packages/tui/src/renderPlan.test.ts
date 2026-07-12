// Run: bun run packages/tui/src/renderPlan.test.ts
import type { AgentEvent } from "@chunky/protocol"
import { buildRenderPlan } from "./renderPlan.ts"
import { initialState, reduce, MAIN, type Item, type ThreadNode } from "./transcript.ts"

let passed = 0
let failed = 0

function assert(cond: unknown, msg: string) {
  if (cond) {
    passed++
  } else {
    failed++
    console.error("FAIL:", msg)
  }
}

function eq(actual: unknown, expected: unknown, msg: string) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) passed++
  else {
    failed++
    console.error(`FAIL: ${msg}\n  expected ${e}\n  actual   ${a}`)
  }
}

function fold(events: AgentEvent[]) {
  return events.reduce(reduce, initialState)
}

// A parent thread that: replies, calls a tool that spawns a child, then — AFTER
// the child finishes — writes its final summary. This is the reported bug: the
// summary must NOT float above the child block.
const CHILD = "thr-child"
const scenario: AgentEvent[] = [
  { type: "message.start", role: "assistant" },
  { type: "message.delta", text: "On it — delegating." },
  { type: "message.end" },
  { type: "tool.start", id: "t1", name: "workflow", input: {} },
  { type: "thread.spawn", threadId: CHILD, parentThreadId: null, title: "Explore" },
  { type: "thread.status", threadId: CHILD, status: "running", title: "Explore" },
  { type: "message.start", role: "assistant", threadId: CHILD },
  { type: "message.delta", text: "child working", threadId: CHILD },
  { type: "message.end", threadId: CHILD },
  { type: "thread.status", threadId: CHILD, status: "idle", title: "Explore" },
  { type: "tool.end", id: "t1", ok: true, output: "done" },
  { type: "message.start", role: "assistant" },
  { type: "message.delta", text: "All threads finished. Summary here." },
  { type: "message.end" },
]

// --- the reducer anchors the child at its spawn point in the parent stream ---
{
  const state = fold(scenario)
  const child = state.threads[CHILD]!
  // At spawn the main thread held [assistant "On it", tool workflow] → anchor 2.
  eq(child.anchorIndex, 2, "child anchored at parent item count when spawned")
  eq(state.threads[MAIN]!.items.length, 3, "main thread has 3 items (reply, tool, summary)")
}

// --- the render plan interleaves the child between the tool and the summary ---
{
  const state = fold(scenario)
  const main = state.threads[MAIN]!
  const children = state.order.map((id) => state.threads[id]!).filter((t) => t.parentId === MAIN)
  const plan = buildRenderPlan(main.items, children)

  eq(
    plan.map((n) => n.kind),
    ["items", "threads", "items"],
    "plan = pre-spawn items · threads · post-spawn items",
  )
  const threadsIdx = plan.findIndex((n) => n.kind === "threads")
  const summaryIdx = plan.findIndex(
    (n) => n.kind === "items" && n.items.some((it) => it.kind === "assistant" && it.text.includes("Summary")),
  )
  assert(threadsIdx >= 0 && summaryIdx > threadsIdx, "the final summary renders BELOW the child thread block")

  const threadsNode = plan[threadsIdx]!
  if (threadsNode.kind === "threads") {
    eq(threadsNode.threads.map((t) => t.id), [CHILD], "the child is the anchored thread")
  }
}

// --- no children: whole list collapses as one segment (backward compatible) ---
{
  const items: Item[] = [
    { kind: "assistant", text: "hi", streaming: false },
    { kind: "tool", id: "a", name: "read", input: {}, done: true, ok: true },
    { kind: "tool", id: "b", name: "read", input: {}, done: true, ok: true },
  ]
  const plan = buildRenderPlan(items, [])
  eq(plan.length, 1, "no children → a single items segment")
  eq(plan[0]!.kind, "items", "that segment is items")
  // The two reads coalesce into one tool-group when collapsed as a whole.
  const seg = plan[0]!
  if (seg.kind === "items") eq(seg.items.some((it) => it.kind === "tool-group"), true, "reads still coalesce")
}

// --- empty items with no children → empty plan ---
eq(buildRenderPlan([], []), [], "empty items + no children → empty plan")

// --- a thread with no recorded anchor falls back to the end ---
{
  const items: Item[] = [
    { kind: "assistant", text: "before", streaming: false },
    { kind: "assistant", text: "after", streaming: false },
  ]
  const orphan: ThreadNode = { id: "x", parentId: MAIN, title: "x", status: "idle", items: [] }
  const plan = buildRenderPlan(items, [orphan])
  eq(plan.map((n) => n.kind), ["items", "threads"], "anchorless thread renders at the end")
}

// --- several threads spawned at the same point render as one group there ---
{
  const items: Item[] = [
    { kind: "assistant", text: "fan out", streaming: false },
    { kind: "tool", id: "wf", name: "workflow", input: {}, done: true, ok: true },
    { kind: "assistant", text: "summary", streaming: false },
  ]
  const mk = (id: string): ThreadNode => ({ id, parentId: MAIN, title: id, status: "idle", anchorIndex: 2, items: [] })
  const plan = buildRenderPlan(items, [mk("a"), mk("b"), mk("c")])
  eq(plan.map((n) => n.kind), ["items", "threads", "items"], "grouped fan-out sits between tool and summary")
  const t = plan.find((n) => n.kind === "threads")!
  if (t.kind === "threads") eq(t.threads.map((x) => x.id), ["a", "b", "c"], "all three threads in spawn order")
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
