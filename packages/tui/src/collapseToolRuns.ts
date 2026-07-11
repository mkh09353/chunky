// A RENDER-TIME transform that coalesces runs of tool calls into compact rows.
// The reducer (transcript.ts) stays a faithful event log — collapsing is purely a
// display concern, so this is a pure function over the final item list, re-run on
// every render. Modelled on kimi's collapseReadSearchGroups, trimmed to chunky's
// flat Item union.
//
// Why: when the agent fires off dozens of reads/searches/bashes back-to-back, one
// row per call (plus a ⎿ preview line each) buries the transcript in an endless
// flat stack. The key lesson from kimi: real agent work ALTERNATES tools
// (read→bash→grep→read→…), so folding only *same-name* runs barely helps. Instead
// we fold any run of consecutive READ-LIKE calls — regardless of name — into one
// line like "⏺ read 5 files · ran 4 commands · searched 2 times". Mutating tools
// (edit/write) break the run and still fold same-name (so "write ×2" stays one row).
import type { Item } from "./transcript.js"

type ToolItem = Extract<Item, { kind: "tool" }>

// Read-like / observational tools: safe to fold across names into one summary. A
// burst of these is noise you skim, not something you inspect call-by-call.
const READLIKE = new Set(["read", "ffgrep", "fffind", "bash"])

/** Is this tool read-like (foldable across names) vs mutating (breaks the run)? */
function isReadlike(name: string): boolean {
  return READLIKE.has(name)
}

/** A coalesced run of 2+ tool calls, rendered as one line (no ⎿ preview). */
export type ToolGroup = {
  kind: "tool-group"
  /** Pre-formatted label: "read 5 files · ran 4 commands" or "write ×2". */
  summary: string
  /** The last call's raw input — the only per-call detail we surface, as a hint. */
  lastInput: unknown
  /** True while any call in the run is still in flight (grey dot); false once done. */
  running: boolean
}

/** What the renderer actually walks: raw items, plus coalesced `tool-group` rows. */
export type DisplayItem = Item | ToolGroup

function plural(n: number, one: string, many = one + "s"): string {
  return `${n} ${n === 1 ? one : many}`
}

/** Summarize a read-like run by category, e.g. "read 3 files · ran 2 commands". */
function summarizeReadlike(run: ToolItem[]): string {
  let reads = 0
  let searches = 0
  let commands = 0
  for (const t of run) {
    if (t.name === "read") reads++
    else if (t.name === "ffgrep" || t.name === "fffind") searches++
    else if (t.name === "bash") commands++
  }
  const parts: string[] = []
  if (reads) parts.push(`read ${plural(reads, "file")}`)
  if (searches) parts.push(`searched ${plural(searches, "time")}`)
  if (commands) parts.push(`ran ${plural(commands, "command")}`)
  return parts.join(" · ")
}

/**
 * Collapse tool runs into compact `tool-group` rows.
 *
 * Rules:
 * - READ-LIKE calls (read / ffgrep / fffind / bash) fold together ACROSS names.
 *   A run of `read, bash, read, grep` becomes one group — this is the whole point,
 *   since agent work alternates tools and same-name folding never triggers.
 * - MUTATING calls (edit / write / apply_patch / spawn_thread) break a read-like
 *   run and fold only among consecutive SAME-name siblings (so "write ×2" is one
 *   row but an edit between two writes splits them).
 * - Any non-tool item (assistant text, user turn, error, cache warning) ends the
 *   current run — grouping never reaches across a break.
 * - Only successful-or-in-flight calls coalesce. An errored call (`ok === false`)
 *   breaks the run and passes through as its own `tool` row so its error line stays
 *   on screen — a failure is never swallowed into a green group.
 * - A run of a single call passes through unchanged: there's nothing to coalesce
 *   and its ⎿ preview is worth the second line. Only 2+ become a group.
 *
 * Counts are just `run.length` — deterministic per render, so (unlike kimi's
 * streaming recompute) no monotonic max-refs are needed to avoid jitter. During
 * streaming a not-yet-done call joins its group optimistically; if it later ends
 * with `ok === false` the next render pops it out as a standalone error row.
 */
export function collapseToolRuns(items: Item[]): DisplayItem[] {
  const out: DisplayItem[] = []
  // The open run and its kind. "readlike" runs mix names; "mutating" runs are
  // same-name only; null means no run is open.
  let run: ToolItem[] = []
  let runKind: "readlike" | "mutating" | null = null

  function flush(): void {
    if (run.length === 0) return
    if (run.length === 1) {
      out.push(run[0]!)
    } else {
      const last = run[run.length - 1]!
      out.push({
        kind: "tool-group",
        summary: runKind === "readlike" ? summarizeReadlike(run) : `${last.name} ×${run.length}`,
        lastInput: last.input,
        running: run.some((t) => !t.done),
      })
    }
    run = []
    runKind = null
  }

  for (const it of items) {
    // Non-tool items and errored calls break any run and render on their own.
    if (it.kind !== "tool" || it.ok === false) {
      flush()
      out.push(it)
      continue
    }
    const kind: "readlike" | "mutating" = isReadlike(it.name) ? "readlike" : "mutating"
    // A run breaks when the kind changes, or — for mutating runs — when the name
    // changes (read-like runs deliberately mix names).
    if (run.length > 0 && (runKind !== kind || (kind === "mutating" && run[0]!.name !== it.name))) {
      flush()
    }
    run.push(it)
    runKind = kind
  }
  flush()
  return out
}
