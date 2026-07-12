// Browser port of packages/tui/src/renderPlan.ts. Interleave a parent thread's
// own items with the child-thread blocks it spawned, each placed at its spawn
// point (anchorIndex). Without this the child threads clump at the BOTTOM, so the
// parent's post-spawn output — its final summary most visibly — floats ABOVE the
// threads that produced it. Pure and re-run per render: the reducer stays a
// faithful event log; chronological ordering is a display concern layered on top.
import type { Item, ThreadNode, TranscriptState } from "./transcript"

export type ToolItem = Extract<Item, { kind: "tool" }>

/** A run of consecutive tool items coalesced into one collapsible group, or a
 *  single non-tool item passed through as-is. */
export type Group =
  | { type: "item"; item: Item }
  | { type: "tools"; tools: ToolItem[] }

/** Collapse consecutive tool items into one group for a cleaner transcript. */
export function groupItems(items: Item[]): Group[] {
  const out: Group[] = []
  let toolBuf: ToolItem[] = []

  const flush = () => {
    if (toolBuf.length) {
      out.push({ type: "tools", tools: toolBuf })
      toolBuf = []
    }
  }

  for (const item of items) {
    if (item.kind === "tool") {
      toolBuf.push(item)
    } else {
      flush()
      out.push({ type: "item", item })
    }
  }
  flush()
  return out
}

/** One render segment: either a run of the parent's OWN grouped items, or the
 *  child-thread blocks anchored at this point in the parent's stream. */
export type RenderNode =
  | { kind: "items"; groups: Group[] }
  | { kind: "threads"; threads: ThreadNode[] }

/** Direct children of `parentId`, in first-seen (spawn) order. */
export function childrenOf(state: TranscriptState, parentId: string): ThreadNode[] {
  return state.order
    .map((id) => state.threads[id]!)
    .filter((t) => t.parentId === parentId)
}

/**
 * Split `items` at each child's spawn anchor and interleave the child blocks, so
 * the transcript reads in true chronological order. Children are grouped by
 * `anchorIndex` (clamped into range); several spawned at the same point render as
 * a group there, in `children` order. A child with no recorded anchor falls back
 * to the end. With no children the whole list groups as one segment — identical to
 * the old single groupItems() call.
 */
export function buildRenderPlan(items: Item[], children: ThreadNode[]): RenderNode[] {
  if (children.length === 0) {
    return items.length > 0 ? [{ kind: "items", groups: groupItems(items) }] : []
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
      plan.push({ kind: "items", groups: groupItems(items.slice(cursor, anchor)) })
      cursor = anchor
    }
    plan.push({ kind: "threads", threads: byAnchor.get(anchor)! })
  }
  if (cursor < items.length) {
    plan.push({ kind: "items", groups: groupItems(items.slice(cursor)) })
  }
  return plan
}

/** The most representative one line of a collapsed thread: the first line of its
 *  latest assistant reply, else the newest tool/log/error line. Mirrors the TUI. */
export function threadPreview(items: Item[]): { text: string; more: number } {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!
    if (it.kind === "assistant" && it.text.trim()) {
      const lines = it.text.split("\n").map((l) => l.trim()).filter(Boolean)
      return { text: lines[0] ?? "", more: Math.max(0, lines.length - 1) }
    }
  }
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!
    if (it.kind === "tool") return { text: `${it.name}…`, more: 0 }
    if (it.kind === "workflow-log") return { text: it.message, more: 0 }
    if (it.kind === "error") return { text: `error: ${it.text}`, more: 0 }
  }
  return { text: "", more: 0 }
}
