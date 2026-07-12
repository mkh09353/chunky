// Browser port of packages/tui/src/transcript.ts — reduce AgentEvents into a
// thread tree the chat UI can render.
import type { AgentEvent, GoalStatus } from "@chunky/protocol"

export const MAIN = "main"

export type Item =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; streaming: boolean }
  | {
      kind: "tool"
      id: string
      name: string
      input: unknown
      done: boolean
      ok?: boolean
      output?: string
    }
  | { kind: "error"; text: string }
  | {
      kind: "cache-warning"
      reason: "idle" | "model-switch"
      idleMs?: number
      approxTokens: number
      fromModel?: string
      toModel?: string
    }
  | {
      kind: "goal"
      status: GoalStatus | "cleared"
      message: string
    }
  /** A client-local status line (slash-command feedback). Never comes from the
   *  server stream, so it is not replayed on resume — session-scoped UI only. */
  | { kind: "notice"; text: string }

export interface ThreadNode {
  id: string
  parentId: string | null
  title: string
  status: "idle" | "running"
  items: Item[]
}

export interface TranscriptState {
  threads: Record<string, ThreadNode>
  order: string[]
  status: "idle" | "running"
}

export const initialState: TranscriptState = {
  threads: {
    [MAIN]: { id: MAIN, parentId: null, title: "main", status: "idle", items: [] },
  },
  order: [MAIN],
  status: "idle",
}

function reduceItems(items: Item[], ev: AgentEvent): Item[] {
  switch (ev.type) {
    case "message.user":
      return [...items, { kind: "user", text: ev.text }]

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
      const closed = items.map((it) =>
        it.kind === "assistant" && it.streaming ? { ...it, streaming: false } : it,
      )
      return [
        ...closed,
        { kind: "tool", id: ev.id, name: ev.name, input: ev.input, done: false },
      ]
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

    case "goal.update": {
      return updateThreadItems(state, MAIN, (items) => [
        ...items,
        {
          kind: "goal",
          status: ev.goal?.status ?? "cleared",
          message: ev.message ?? "Goal updated.",
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

    case "message.user":
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

/** Append a client-local notice line (slash-command feedback) to the main thread. */
export function pushNotice(state: TranscriptState, text: string): TranscriptState {
  return updateThreadItems(state, MAIN, (items) => [...items, { kind: "notice", text }])
}

/** Flatten main-thread items for the primary chat pane. */
export function mainItems(state: TranscriptState): Item[] {
  return state.threads[MAIN]?.items ?? []
}

export function hasTranscript(state: TranscriptState): boolean {
  return (state.threads[MAIN]?.items.length ?? 0) > 0 || state.order.length > 1
}
