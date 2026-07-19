// Run: bun run packages/app/src/mainview/lib/minimap.test.ts
import type { AgentEvent } from "@chunky/protocol"
import { buildMinimapEntries } from "./minimap.ts"
import { initialState, reduce } from "./transcript.ts"

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

const say = (text: string): AgentEvent[] => [
  { type: "message.start" } as AgentEvent,
  { type: "message.delta", text } as AgentEvent,
  { type: "message.end" } as AgentEvent,
]

// --- one entry per prompt, paired with the reply it drew ---------------------
{
  const state = fold([
    { type: "message.user", text: "first question" } as AgentEvent,
    ...say("first answer"),
    { type: "message.user", text: "second question" } as AgentEvent,
    ...say("second answer"),
  ])
  const entries = buildMinimapEntries(state)
  eq(entries.length, 2, "one entry per user message")
  eq(entries[0], { prompt: "first question", reply: "first answer" }, "prompt pairs with its own reply")
  eq(entries[1], { prompt: "second question", reply: "second answer" }, "second pair is independent")
}

// --- a reply is never borrowed from a LATER turn -----------------------------
{
  const state = fold([
    { type: "message.user", text: "unanswered" } as AgentEvent,
    { type: "message.user", text: "answered" } as AgentEvent,
    ...say("the reply"),
  ])
  const entries = buildMinimapEntries(state)
  eq(entries[0]!.reply, "", "a prompt with no reply before the next prompt yields no snippet")
  eq(entries[1]!.reply, "the reply", "the reply belongs to the prompt it followed")
}

// --- tool-only turns and streaming-but-empty replies ------------------------
{
  const state = fold([
    { type: "message.user", text: "run the build" } as AgentEvent,
    { type: "tool.start", id: "t1", name: "bash", input: { command: "make" } } as AgentEvent,
    { type: "tool.end", id: "t1", ok: true, output: "done" } as AgentEvent,
  ])
  const entries = buildMinimapEntries(state)
  eq(entries.length, 1, "a tool-only turn still gets a bar")
  eq(entries[0]!.reply, "", "no assistant text yet means no reply snippet")
}

// --- multi-line prompts collapse to a single line ---------------------------
{
  const state = fold([
    { type: "message.user", text: "line one\n\n   line two\tline three  " } as AgentEvent,
    ...say("ok\nsecond line"),
  ])
  const entries = buildMinimapEntries(state)
  eq(entries[0]!.prompt, "line one line two line three", "whitespace collapses to one tidy line")
  eq(entries[0]!.reply, "ok second line", "reply snippet collapses too")
}

// --- long text is clipped with an ellipsis ----------------------------------
{
  const long = "x".repeat(500)
  const state = fold([{ type: "message.user", text: long } as AgentEvent, ...say(long)])
  const entries = buildMinimapEntries(state)
  assert(entries[0]!.prompt.length <= 120, "prompt is clipped to the snippet budget")
  assert(entries[0]!.prompt.endsWith("…"), "clipped prompt is marked with an ellipsis")
  assert(entries[0]!.reply.length <= 140, "reply is clipped to its own budget")
}

// --- child-thread prompts are excluded (they have no stable anchor) ---------
{
  const state = fold([
    { type: "message.user", text: "main prompt" } as AgentEvent,
    { type: "thread.spawn", threadId: "t1", title: "child", parentThreadId: null } as AgentEvent,
    { type: "message.user", text: "child prompt", threadId: "t1" } as AgentEvent,
  ])
  const entries = buildMinimapEntries(state)
  eq(entries.length, 1, "only main-thread prompts get bars")
  eq(entries[0]!.prompt, "main prompt", "the child's prompt is not counted")
}

// --- an empty transcript yields no bars -------------------------------------
{
  eq(buildMinimapEntries(initialState).length, 0, "empty transcript has no entries")
}

console.log(`${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
