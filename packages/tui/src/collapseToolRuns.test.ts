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

// A coalesced group with the given summary/hint/running state.
function group(summary: string, lastInput: unknown, running = false) {
  return { kind: "tool-group", summary, lastInput, running }
}

// --- a lone call stays a `tool` row (nothing to coalesce) ---
eq(
  collapseToolRuns([tool("r1", "read", { path: "a" })]),
  [tool("r1", "read", { path: "a" })],
  "single call passes through unchanged",
)

// --- consecutive same-name reads coalesce into one read-like group ---
eq(
  collapseToolRuns([
    tool("r1", "read", { path: "a" }),
    tool("r2", "read", { path: "b" }),
    tool("r3", "read", { path: "c" }),
  ]),
  [group("read 3 files", { path: "c" })],
  "run of 3 reads → 'read 3 files' with last input as hint",
)

// --- THE POINT: read-like tools fold ACROSS names into one summary ---
eq(
  collapseToolRuns([
    tool("r1", "read", { path: "a" }),
    tool("b1", "bash", { cmd: "ls" }),
    tool("r2", "read", { path: "b" }),
    tool("g1", "ffgrep", { pattern: "foo" }),
    tool("b2", "bash", { cmd: "pwd" }),
  ]),
  [group("read 2 files · searched 1 time · ran 2 commands", { cmd: "pwd" })],
  "alternating read/bash/grep fold into one by-category summary",
)

// --- an interleaved assistant message breaks the run ---
eq(
  collapseToolRuns([
    tool("r1", "read", { path: "a" }),
    tool("b1", "bash", { cmd: "ls" }),
    { kind: "assistant", text: "thinking…", streaming: false },
    tool("r2", "read", { path: "c" }),
    tool("r3", "read", { path: "d" }),
  ]),
  [
    group("read 1 file · ran 1 command", { cmd: "ls" }),
    { kind: "assistant", text: "thinking…", streaming: false },
    group("read 2 files", { path: "d" }),
  ],
  "assistant text splits one run into two groups",
)

// --- mutating tools break a read-like run and fold only same-name ---
eq(
  collapseToolRuns([
    tool("r1", "read", { path: "a" }),
    tool("r2", "read", { path: "b" }),
    tool("w1", "write", { path: "x" }),
    tool("w2", "write", { path: "y" }),
  ]),
  [group("read 2 files", { path: "b" }), group("write ×2", { path: "y" })],
  "reads fold across; writes fold same-name as 'write ×2'",
)

// --- a mutating tool between two writes splits them (same-name only) ---
eq(
  collapseToolRuns([
    tool("w1", "write", { path: "x" }),
    tool("e1", "edit", { path: "z" }),
    tool("w2", "write", { path: "y" }),
  ]),
  [
    tool("w1", "write", { path: "x" }),
    tool("e1", "edit", { path: "z" }),
    tool("w2", "write", { path: "y" }),
  ],
  "write/edit/write never merge (three lone mutating rows)",
)

// --- an errored call is NOT hidden: it breaks the run and stays a `tool` row ---
{
  const errored = tool("r3", "read", { path: "boom" }, { ok: false, output: "ENOENT" })
  eq(
    collapseToolRuns([
      tool("r1", "read", { path: "a" }),
      tool("b1", "bash", { cmd: "ls" }),
      errored,
      tool("r4", "read", { path: "d" }),
      tool("r5", "read", { path: "e" }),
    ]),
    [group("read 1 file · ran 1 command", { cmd: "ls" }), errored, group("read 2 files", { path: "e" })],
    "errored call surfaces standalone between two green groups",
  )
}

// --- a still-running last call marks the whole group as running (grey dot) ---
eq(
  collapseToolRuns([
    tool("r1", "read", { path: "a" }),
    tool("r2", "read", { path: "b" }, { done: false }),
  ]),
  [group("read 2 files", { path: "b" }, true)],
  "in-flight call → group.running is true",
)

// --- the full mixed transcript, end to end ---
{
  const errored = tool("t7", "read", { path: "d" }, { ok: false, output: "denied" })
  const out = collapseToolRuns([
    tool("t1", "read", { path: "a" }),
    tool("t2", "read", { path: "b" }),
    tool("t3", "bash", { cmd: "ls" }),
    { kind: "assistant", text: "hello", streaming: false },
    tool("t4", "bash", { cmd: "pwd" }),
    tool("t5", "ffgrep", { pattern: "x" }),
    errored,
    tool("t8", "read", { path: "e" }),
    tool("t9", "read", { path: "f" }),
  ])
  eq(out.length, 5, "mixed transcript collapses to 5 display rows")
  eq(out[0], group("read 2 files · ran 1 command", { cmd: "ls" }), "mixed: leading read/bash fold")
  eq(out[1], { kind: "assistant", text: "hello", streaming: false }, "mixed: assistant preserved")
  eq(out[2], group("searched 1 time · ran 1 command", { pattern: "x" }), "mixed: bash+grep fold")
  eq(out[3], errored, "mixed: errored read stays visible")
  eq(out[4], group("read 2 files", { path: "f" }), "mixed: trailing reads fold")
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
