// Interleave a parent thread's own transcript items with the child-thread blocks
// it spawned, placing each child at the point in the parent's stream where it was
// spawned (its anchorIndex). Without this, every child renders in one clump at the
// BOTTOM of the parent — so the parent's post-spawn output (its final summary, most
// visibly) wrongly appears ABOVE the threads that produced it. Pure and re-run per
// render, mirroring collapseToolRuns: the reducer stays a faithful event log;
// chronological ordering is purely a display concern layered on top.
import { collapseToolRuns, type DisplayItem } from "./collapseToolRuns.js"
import type { Item, ThreadNode } from "./transcript.js"

/** One render segment: either a collapsed run of the parent's OWN items, or the
 *  child-thread blocks anchored at this point in the parent's stream. */
export type RenderNode =
  | { kind: "items"; items: DisplayItem[] }
  | { kind: "threads"; threads: ThreadNode[] }

/**
 * Split `items` at each child's spawn anchor and interleave the child blocks, so
 * the transcript reads in true chronological order. Children are grouped by
 * `anchorIndex` (clamped into range); several spawned at the same point render as
 * a group there, in `children` order. A child with no recorded anchor falls back
 * to the end — the pre-anchor behaviour. With no children, the whole list collapses
 * as one segment, identical to the old single collapseToolRuns() call.
 */
export function buildRenderPlan(items: Item[], children: ThreadNode[]): RenderNode[] {
  if (children.length === 0) {
    return items.length > 0 ? [{ kind: "items", items: collapseToolRuns(items) }] : []
  }
  const byAnchor = new Map<number, ThreadNode[]>()
  for (const thread of children) {
    const anchor = Math.max(0, Math.min(items.length, thread.anchorIndex ?? items.length))
    const bucket = byAnchor.get(anchor)
    if (bucket) bucket.push(thread)
    else byAnchor.set(anchor, [thread])
  }
  const plan: RenderNode[] = []
  let cursor = 0
  for (const anchor of [...byAnchor.keys()].sort((a, b) => a - b)) {
    if (anchor > cursor) {
      plan.push({ kind: "items", items: collapseToolRuns(items.slice(cursor, anchor)) })
      cursor = anchor
    }
    plan.push({ kind: "threads", threads: byAnchor.get(anchor)! })
  }
  if (cursor < items.length) {
    plan.push({ kind: "items", items: collapseToolRuns(items.slice(cursor)) })
  }
  return plan
}
