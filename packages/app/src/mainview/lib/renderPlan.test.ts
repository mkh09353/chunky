// Run: bun run packages/app/src/mainview/lib/renderPlan.test.ts
import type { AgentEvent } from "@chunky/protocol"
import { buildRenderPlan, childrenOf, groupItems, threadPreview } from "./renderPlan.ts"
import { initialState, reduce, MAIN, type Item, type ThreadNode } from "./transcript.ts"

let passed = 0
let failed = 0

function assert(cond: unknown, msg: string) {
  if (cond) passed++
  else {
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

const fold = (events: AgentEvent[]) => events.reduce(reduce, initialState)

// A parent that replies, calls a tool that spawns a child, then — AFTER the child
// finishes — writes its final summary. The summary must NOT float above the child.
const CHILD = "thr-child"
const scenario: AgentEvent[] = [
  { type: "message.start", role: "assistant" },
  { type: "message.delta", text: "On it — delegating." },
  { type: "message.end" },
  { type: "tool.start", id: "t1", name: "workflow", input: {} },
  { type: "thread.spawn", threadId: CHILD, parentThreadId: null, title: "Explore", model: "grok-4.5" },
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

// --- reducer anchors the child + records its model ---
{
  const state = fold(scenario)
  const child = state.threads[CHILD]!
  eq(child.anchorIndex, 2, "child anchored at parent item count when spawned")
  eq(child.model, "grok-4.5", "child records its effective model for the header")
  eq(state.threads[MAIN]!.items.length, 3, "main thread has 3 items (reply, tool, summary)")
}

// --- render plan interleaves the child between the tool and the summary ---
{
  const state = fold(scenario)
  const main = state.threads[MAIN]!
  const plan = buildRenderPlan(main.items, childrenOf(state, MAIN))

  eq(plan.map((n) => n.kind), ["items", "threads", "items"], "plan = pre · threads · post")
  const threadsIdx = plan.findIndex((n) => n.kind === "threads")
  const summaryIdx = plan.findIndex(
    (n) =>
      n.kind === "items" &&
      n.groups.some((g) => g.type === "item" && g.item.kind === "assistant" && g.item.text.includes("Summary")),
  )
  assert(threadsIdx >= 0 && summaryIdx > threadsIdx, "the final summary renders BELOW the child thread block")
}

// --- workflow phase/log events land as items on the running thread ---
{
  const state = fold([
    { type: "workflow.phase", runId: "w", title: "Scan" },
    { type: "workflow.log", runId: "w", message: "3/10 found" },
  ])
  const items = state.threads[MAIN]!.items
  eq(items.map((it) => it.kind), ["workflow-phase", "workflow-log"], "workflow events reduce to items")
}

// --- no children: whole list groups as one segment (backward compatible) ---
{
  const items: Item[] = [
    { kind: "assistant", text: "hi", streaming: false },
    { kind: "tool", id: "a", name: "read", input: {}, done: true, ok: true },
    { kind: "tool", id: "b", name: "read", input: {}, done: true, ok: true },
  ]
  const plan = buildRenderPlan(items, [])
  eq(plan.length, 1, "no children → a single items segment")
  const seg = plan[0]!
  if (seg.kind === "items") eq(seg.groups.some((g) => g.type === "tools"), true, "consecutive tools still coalesce")
}

// --- empty items + no children → empty plan ---
eq(buildRenderPlan([], []), [], "empty items + no children → empty plan")

// --- output-limit reason survives reduction for visible incomplete-state UI ---
{
  const state = fold([
    { type: "message.start", role: "assistant" },
    { type: "message.delta", text: "partial" },
    { type: "message.end", reason: "max_tokens" },
  ])
  eq(state.threads[MAIN]!.items[0], { kind: "assistant", text: "partial", streaming: false, endReason: "max_tokens" }, "output-limit reason is retained")
}

// --- anchorless thread falls back to the end ---
{
  const items: Item[] = [
    { kind: "assistant", text: "before", streaming: false },
    { kind: "assistant", text: "after", streaming: false },
  ]
  const orphan: ThreadNode = { id: "x", parentId: MAIN, title: "x", status: "idle", items: [] }
  eq(buildRenderPlan(items, [orphan]).map((n) => n.kind), ["items", "threads"], "anchorless thread renders last")
}

// --- preview surfaces the latest assistant line ---
{
  const items: Item[] = [
    { kind: "tool", id: "a", name: "read", input: {}, done: true, ok: true },
    { kind: "assistant", text: "line one\nline two", streaming: false },
  ]
  eq(threadPreview(items), { text: "line one", more: 1 }, "preview = first line of latest reply + more count")
}

// --- grouping never crosses a non-tool item ---
{
  const items: Item[] = [
    { kind: "tool", id: "a", name: "read", input: {}, done: true, ok: true },
    { kind: "assistant", text: "x", streaming: false },
    { kind: "tool", id: "b", name: "read", input: {}, done: true, ok: true },
  ]
  eq(groupItems(items).map((g) => g.type), ["tools", "item", "tools"], "an assistant line splits two tool runs")
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
