// Run: bun run packages/tui/src/collapseToolRuns.test.ts
import { collapseToolRuns } from "./collapseToolRuns.ts"
import type { Item } from "./transcript.ts"

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
  if (a === e) {
    passed++
  } else {
    failed++
    console.error("FAIL:", msg)
    console.error("  expected:", e)
    console.error("  actual:  ", a)
  }
}

// A done, successful tool call. `ok` defaults true; pass done:false for in-flight.
function tool(
  id: string,
  name: string,
  input: unknown,
  opts: { ok?: boolean; done?: boolean; output?: string } = {},
): Item {
  const done = opts.done ?? true
  return {
    kind: "tool",
    id,
    name,
    input,
    done,
    ...(opts.ok !== undefined ? { ok: opts.ok } : {}),
    ...(opts.output !== undefined ? { output: opts.output } : {}),
  }
}

// --- a lone call stays a `tool` row (nothing to coalesce) ---
eq(
  collapseToolRuns([tool("r1", "read", { path: "a" })]),
  [tool("r1", "read", { path: "a" })],
  "single call passes through unchanged",
)

// --- consecutive same-name calls coalesce into one group ---
eq(
  collapseToolRuns([
    tool("r1", "read", { path: "a" }),
    tool("r2", "read", { path: "b" }),
    tool("r3", "read", { path: "c" }),
  ]),
  [{ kind: "tool-group", name: "read", count: 3, lastInput: { path: "c" }, running: false }],
  "run of 3 reads → group ×3 with last input as hint",
)

// --- an interleaved assistant message breaks the run ---
eq(
  collapseToolRuns([
    tool("r1", "read", { path: "a" }),
    tool("r2", "read", { path: "b" }),
    { kind: "assistant", text: "thinking…", streaming: false },
    tool("r3", "read", { path: "c" }),
    tool("r4", "read", { path: "d" }),
  ]),
  [
    { kind: "tool-group", name: "read", count: 2, lastInput: { path: "b" }, running: false },
    { kind: "assistant", text: "thinking…", streaming: false },
    { kind: "tool-group", name: "read", count: 2, lastInput: { path: "d" }, running: false },
  ],
  "assistant text splits one run into two groups",
)

// --- a differently-named tool breaks the run too ---
eq(
  collapseToolRuns([
    tool("r1", "read", { path: "a" }),
    tool("b1", "bash", { cmd: "ls" }),
    tool("r2", "read", { path: "b" }),
  ]),
  [
    tool("r1", "read", { path: "a" }),
    tool("b1", "bash", { cmd: "ls" }),
    tool("r2", "read", { path: "b" }),
  ],
  "alternating names never merge (three lone rows)",
)

// --- an errored call is NOT hidden: it breaks the run and stays a `tool` row ---
{
  const errored = tool("r3", "read", { path: "boom" }, { ok: false, output: "ENOENT" })
  eq(
    collapseToolRuns([
      tool("r1", "read", { path: "a" }),
      tool("r2", "read", { path: "b" }),
      errored,
      tool("r4", "read", { path: "d" }),
      tool("r5", "read", { path: "e" }),
    ]),
    [
      { kind: "tool-group", name: "read", count: 2, lastInput: { path: "b" }, running: false },
      errored,
      { kind: "tool-group", name: "read", count: 2, lastInput: { path: "e" }, running: false },
    ],
    "errored call surfaces standalone between two green groups",
  )
}

// --- a still-running last call marks the whole group as running (grey dot) ---
eq(
  collapseToolRuns([
    tool("r1", "read", { path: "a" }),
    tool("r2", "read", { path: "b" }, { done: false }),
  ]),
  [{ kind: "tool-group", name: "read", count: 2, lastInput: { path: "b" }, running: true }],
  "in-flight call → group.running is true",
)

// --- the full mixed transcript the task describes, end to end ---
{
  const errored = tool("t7", "read", { path: "d" }, { ok: false, output: "denied" })
  const out = collapseToolRuns([
    tool("t1", "read", { path: "a" }),
    tool("t2", "read", { path: "b" }),
    tool("t3", "read", { path: "c" }),
    { kind: "assistant", text: "hello", streaming: false },
    tool("t4", "bash", { cmd: "ls" }),
    tool("t5", "bash", { cmd: "pwd" }),
    errored,
    tool("t8", "read", { path: "e" }),
    tool("t9", "read", { path: "f" }),
  ])
  eq(out.length, 5, "mixed transcript collapses to 5 display rows")
  eq(out[0], { kind: "tool-group", name: "read", count: 3, lastInput: { path: "c" }, running: false }, "mixed: reads ×3")
  eq(out[1], { kind: "assistant", text: "hello", streaming: false }, "mixed: assistant preserved")
  eq(out[2], { kind: "tool-group", name: "bash", count: 2, lastInput: { cmd: "pwd" }, running: false }, "mixed: bash ×2")
  eq(out[3], errored, "mixed: errored read stays visible")
  eq(out[4], { kind: "tool-group", name: "read", count: 2, lastInput: { path: "f" }, running: false }, "mixed: trailing reads ×2")
}

// --- non-tool items (errors, cache warnings) pass through and break runs ---
eq(
  collapseToolRuns([
    tool("r1", "read", { path: "a" }),
    { kind: "error", text: "boom" },
    tool("r2", "read", { path: "b" }),
  ]),
  [
    tool("r1", "read", { path: "a" }),
    { kind: "error", text: "boom" },
    tool("r2", "read", { path: "b" }),
  ],
  "an error item breaks the run and passes through",
)

// --- an empty list yields nothing ---
eq(collapseToolRuns([]), [], "empty input → empty output")

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
