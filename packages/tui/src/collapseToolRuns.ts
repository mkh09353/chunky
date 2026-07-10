// A RENDER-TIME transform that coalesces a run of consecutive same-tool calls
// into one compact row. The reducer (transcript.ts) stays a faithful event log —
// collapsing is purely a display concern, so this is a pure function over the
// final item list, re-run on every render. Modelled on kimi's collapseReadSearch,
// trimmed to chunky's flat Item union.
//
// Why: when the agent fires off dozens of reads/bashes back-to-back, one row per
// call (plus a ⎿ preview line each) buries the transcript in an endless flat
// stack. Coalescing a run into "⏺ read ×7 · <last input>" keeps it legible.
import type { Item } from "./transcript.js"

type ToolItem = Extract<Item, { kind: "tool" }>

/** A coalesced run of 2+ consecutive same-name tool calls, rendered as one line. */
export type ToolGroup = {
  kind: "tool-group"
  /** The shared tool name for every call in the run. */
  name: string
  /** How many calls were coalesced — always ≥ 2 (a lone call stays a `tool`). */
  count: number
  /** The last call's raw input — the only summary we surface, as a trailing hint. */
  lastInput: unknown
  /** True while any call in the run is still in flight (grey dot); false once all done (green). */
  running: boolean
}

/** What the renderer actually walks: raw items, plus coalesced `tool-group` rows. */
export type DisplayItem = Item | ToolGroup

/**
 * Collapse consecutive same-name tool calls into `tool-group` rows.
 *
 * Rules:
 * - A run is only *consecutive* tool items sharing the same `name`. Any non-tool
 *   item (assistant text, user turn, error, cache warning) or a differently-named
 *   tool ends the run — grouping never reaches across a break.
 * - Only successful-or-in-flight calls coalesce. An errored call (`ok === false`)
 *   is never hidden inside a green group: it breaks the run and passes through as
 *   its own `tool` row so its error line stays on screen.
 * - A run of a single call also passes through unchanged — there's nothing to
 *   coalesce and its ⎿ preview is worth the second line. Only 2+ become a group.
 *
 * Counts are just `run.length` — deterministic per render, so (unlike kimi's
 * streaming recompute) no monotonic max-refs are needed to avoid jitter. During
 * streaming a not-yet-done call joins its group optimistically; if it later ends
 * with `ok === false` the next render pops it out as a standalone error row.
 */
export function collapseToolRuns(items: Item[]): DisplayItem[] {
  const out: DisplayItem[] = []
  let run: ToolItem[] = []

  function flush(): void {
    if (run.length === 0) return
    if (run.length === 1) {
      out.push(run[0]!)
    } else {
      const last = run[run.length - 1]!
      out.push({
        kind: "tool-group",
        name: last.name,
        count: run.length,
        lastInput: last.input,
        running: run.some((t) => !t.done),
      })
    }
    run = []
  }

  for (const it of items) {
    // A successful-or-in-flight tool call coalesces; everything else — non-tool
    // items AND errored calls (ok === false) — breaks the run and renders on its
    // own, so a failure is never swallowed into a green group.
    if (it.kind === "tool" && it.ok !== false) {
      // A different tool name starts a fresh run — flush what we have first.
      if (run.length > 0 && run[0]!.name !== it.name) flush()
      run.push(it)
    } else {
      flush()
      out.push(it)
    }
  }
  flush()
  return out
}
