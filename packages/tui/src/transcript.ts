// Reduce a stream of AgentEvents into a TREE of threads, each with its own
// renderable transcript items. The main session thread is keyed by MAIN; every
// spawned child thread is keyed by its own threadId and linked to its parent
// (parentId === MAIN for a direct child of the main thread). message/tool/error
// events carry an optional `threadId` that routes them to the owning thread.
import type { AgentEvent } from "@chunky/protocol"

/** Synthetic id for the main (root) session thread — events omit threadId for it. */
export const MAIN = "main"

export type Item =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; streaming: boolean }
  | { kind: "tool"; id: string; name: string; input: unknown; done: boolean; ok?: boolean; output?: string }
  | { kind: "error"; text: string }
  /** Prompt cache went cold at the start of this turn (idle past TTL / model switch). */
  | {
      kind: "cache-warning"
      reason: "idle" | "model-switch"
      idleMs?: number
      approxTokens: number
      fromModel?: string
      toModel?: string
    }

export interface ThreadNode {
  id: string
  parentId: string | null
  title: string
  status: "idle" | "running"
  items: Item[]
}

export interface TranscriptState {
  /** Every thread by id, including MAIN. */
  threads: Record<string, ThreadNode>
  /** Thread ids in first-seen order (MAIN first) so render order is stable. */
  order: string[]
  /** Session-level status (drives the top-level spinner). */
  status: "idle" | "running"
}

export const initialState: TranscriptState = {
  threads: { [MAIN]: { id: MAIN, parentId: null, title: "main", status: "idle", items: [] } },
  order: [MAIN],
  status: "idle",
}

/** Fold one item-level event into a thread's item list (the classic flat reducer). */
function reduceItems(items: Item[], ev: AgentEvent): Item[] {
  switch (ev.type) {
    case "message.start":
      return [...items, { kind: "assistant", text: "", streaming: true }]

    case "message.delta": {
      const next = [...items]
      for (let i = next.length - 1; i >= 0; i--) {
        const it = next[i]!
        if (it.kind === "assistant" && it.streaming) {
          next[i] = { ...it, text: it.text + ev.text }
          return next
        }
      }
      // Deltas without an explicit message.start still open a block.
      return [...next, { kind: "assistant", text: ev.text, streaming: true }]
    }

    case "message.end": {
      const next = [...items]
      for (let i = next.length - 1; i >= 0; i--) {
        const it = next[i]!
        if (it.kind === "assistant" && it.streaming) {
          next[i] = { ...it, streaming: false }
          break
        }
      }
      return next
    }

    case "tool.start": {
      // Close any open assistant block so text after the tool renders below it.
      const closed = items.map((it) =>
        it.kind === "assistant" && it.streaming ? { ...it, streaming: false } : it,
      )
      return [...closed, { kind: "tool", id: ev.id, name: ev.name, input: ev.input, done: false }]
    }

    case "tool.end":
      return items.map((it) =>
        it.kind === "tool" && it.id === ev.id
          ? { ...it, done: true, ok: ev.ok, output: ev.output }
          : it,
      )

    case "error":
      return [...items, { kind: "error", text: ev.message }]

    default:
      return items
  }
}

/** Return a copy of state with `threadId`'s items replaced by `fn(items)`. */
function updateThreadItems(
  state: TranscriptState,
  threadId: string,
  fn: (items: Item[]) => Item[],
): TranscriptState {
  const thread = state.threads[threadId] ?? {
    id: threadId,
    parentId: MAIN,
    title: threadId,
    status: "running" as const,
    items: [],
  }
  const order = state.threads[threadId] ? state.order : [...state.order, threadId]
  return {
    ...state,
    order,
    threads: { ...state.threads, [threadId]: { ...thread, items: fn(thread.items) } },
  }
}

/** Pure reducer: fold one AgentEvent into the thread tree. */
export function reduce(state: TranscriptState, ev: AgentEvent): TranscriptState {
  switch (ev.type) {
    case "session.status": {
      const main = state.threads[MAIN]!
      return {
        ...state,
        status: ev.status,
        threads: { ...state.threads, [MAIN]: { ...main, status: ev.status } },
      }
    }

    case "cache.warning": {
      const threadId = ev.threadId || MAIN
      return updateThreadItems(state, threadId, (items) => [
        ...items,
        {
          kind: "cache-warning",
          reason: ev.reason,
          approxTokens: ev.approxTokens,
          ...(ev.idleMs != null ? { idleMs: ev.idleMs } : {}),
          ...(ev.fromModel ? { fromModel: ev.fromModel } : {}),
          ...(ev.toModel ? { toModel: ev.toModel } : {}),
        },
      ])
    }

    case "thread.spawn": {
      const parentId = ev.parentThreadId ?? MAIN
      const existing = state.threads[ev.threadId]
      const node: ThreadNode = {
        id: ev.threadId,
        parentId,
        title: ev.title,
        status: "running",
        items: existing?.items ?? [],
      }
      return {
        ...state,
        order: existing ? state.order : [...state.order, ev.threadId],
        threads: { ...state.threads, [ev.threadId]: node },
      }
    }

    case "thread.status": {
      const existing = state.threads[ev.threadId]
      const node: ThreadNode = existing
        ? { ...existing, status: ev.status, title: ev.title ?? existing.title }
        : {
            id: ev.threadId,
            parentId: MAIN,
            title: ev.title ?? ev.threadId,
            status: ev.status,
            items: [],
          }
      return {
        ...state,
        order: existing ? state.order : [...state.order, ev.threadId],
        threads: { ...state.threads, [ev.threadId]: node },
      }
    }

    case "message.start":
    case "message.delta":
    case "message.end":
    case "tool.start":
    case "tool.end":
    case "error": {
      const threadId = ("threadId" in ev && ev.threadId) || MAIN
      return updateThreadItems(state, threadId, (items) => reduceItems(items, ev))
    }

    default:
      return state
  }
}

export function pushUser(state: TranscriptState, text: string): TranscriptState {
  return updateThreadItems(state, MAIN, (items) => [...items, { kind: "user", text }])
}
