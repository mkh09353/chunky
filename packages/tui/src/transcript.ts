// Reduce a stream of AgentEvents into a TREE of threads, each with its own
// renderable transcript items. The main session thread is keyed by MAIN; every
// spawned child thread is keyed by its own threadId and linked to its parent
// (parentId === MAIN for a direct child of the main thread). message/tool/error
// events carry an optional `threadId` that routes them to the owning thread.
import type { AgentEvent, GoalStatus, MessageEndReason } from "@chunky/protocol"

/** Synthetic id for the main (root) session thread — events omit threadId for it. */
export const MAIN = "main"

export type Item =
  /** `from` marks a message injected by ANOTHER session via send_to_session. */
  | { kind: "user"; text: string; from?: string; localId?: string }
  | { kind: "assistant"; text: string; streaming: boolean; endReason?: MessageEndReason }
  /** Extended-thinking block streamed before the answer. `id` is thread-stable so
   *  the renderer can key its collapsed/expanded state. */
  | { kind: "reasoning"; id: string; text: string; streaming: boolean }
  /** `progress` is LIVE-ONLY text streamed by the tool while it runs (tool.progress).
   *  It is never persisted or replayed by the server, and tool.end REPLACES it with
   *  the authoritative `output` — so it exists only between start and end. */
  | {
      kind: "tool"
      id: string
      name: string
      input: unknown
      done: boolean
      ok?: boolean
      output?: string
      progress?: string
    }
  | { kind: "error"; text: string }
  /** A persisted boundary marking LangChain context summarization. */
  | { kind: "compaction-notice"; message: string }
  /** A goal-mode lifecycle marker (set / continuing / complete / blocked / paused / cleared). */
  | { kind: "goal"; status: GoalStatus | "cleared"; message: string }
  /** A dynamic-workflow phase header, rendered in the thread that ran `workflow`. */
  | { kind: "workflow-phase"; title: string }
  /** A dynamic-workflow narrator line (start/finish, log()). */
  | { kind: "workflow-log"; message: string }
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
  /** Effective model running this thread (from thread.spawn) — shown in its header. */
  model?: string
  /** How many items the PARENT thread had when this thread was spawned — the point
   *  in the parent's stream where this thread belongs chronologically. The renderer
   *  anchors the thread's block here (inline), so the parent's post-spawn output
   *  (e.g. its final summary) renders BELOW it, not above. Undefined for threads
   *  created before their spawn event (fallback paths) → rendered at the end. */
  anchorIndex?: number
  /** Wall-clock ms when this thread started RUNNING — drives the header's elapsed
   *  clock. Live-only: cleared whenever the thread leaves `running`, so a replayed
   *  (historic) transcript never renders bogus clocks. */
  startedAt?: number
  /** Wall-clock ms of the most recent event routed to this thread (including
   *  tool.progress chunks and reasoning deltas) — drives the idle clock.
   *  Live-only, cleared alongside `startedAt`. */
  lastEventAt?: number
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

/** Rebuild the projection from a server history replay, preventing duplicate
 * rows when an SSE reconnect replays the complete session history. */
export function replayHistory(events: AgentEvent[]): TranscriptState {
  return events.reduce(reduce, initialState)
}

export const initialState: TranscriptState = {
  threads: { [MAIN]: { id: MAIN, parentId: null, title: "main", status: "idle", items: [] } },
  order: [MAIN],
  status: "idle",
}

/** Hard cap on accumulated per-tool progress text. A chatty tool (a test runner,
 *  a build) can stream megabytes; we only ever render the tail, so keep the tail
 *  and drop the oldest bytes rather than growing without bound. */
const PROGRESS_MAX_BYTES = 64 * 1024

/** Append a progress chunk, trimming from the FRONT once past the cap. */
function appendProgress(prev: string | undefined, chunk: string): string {
  const next = (prev ?? "") + chunk
  return next.length > PROGRESS_MAX_BYTES ? next.slice(next.length - PROGRESS_MAX_BYTES) : next
}

/** Mark any still-streaming reasoning block as finished (the answer or a tool has
 *  started, so thinking is over even if no explicit reasoning.end arrived). */
function closeOpenReasoning(items: Item[]): Item[] {
  let changed = false
  const next = items.map((it) => {
    if (it.kind === "reasoning" && it.streaming) {
      changed = true
      return { ...it, streaming: false }
    }
    return it
  })
  return changed ? next : items
}

/** Fold one item-level event into a thread's item list (the classic flat reducer).
 *  `threadId` scopes generated ids (reasoning) so they're unique across threads. */
function reduceItems(items: Item[], ev: AgentEvent, threadId: string): Item[] {
  switch (ev.type) {
    case "reasoning.start": {
      const seq = items.filter((it) => it.kind === "reasoning").length
      return [...items, { kind: "reasoning", id: `${threadId}:r${seq}`, text: "", streaming: true }]
    }

    case "reasoning.delta": {
      const next = [...items]
      for (let i = next.length - 1; i >= 0; i--) {
        const it = next[i]!
        if (it.kind === "reasoning" && it.streaming) {
          next[i] = { ...it, text: it.text + ev.text }
          return next
        }
      }
      // A delta with no open block (e.g. resume mid-stream) still opens one.
      const seq = items.filter((it) => it.kind === "reasoning").length
      return [...next, { kind: "reasoning", id: `${threadId}:r${seq}`, text: ev.text, streaming: true }]
    }

    case "reasoning.end":
      return closeOpenReasoning(items)

    case "message.start":
      return [...closeOpenReasoning(items), { kind: "assistant", text: "", streaming: true }]

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
          next[i] = { ...it, streaming: false, ...(ev.reason ? { endReason: ev.reason } : {}) }
          break
        }
      }
      return next
    }

    case "tool.start": {
      // Close any open assistant/reasoning block so text after the tool renders below it.
      const closed = closeOpenReasoning(items).map((it) =>
        it.kind === "assistant" && it.streaming ? { ...it, streaming: false } : it,
      )
      return [...closed, { kind: "tool", id: ev.id, name: ev.name, input: ev.input, done: false }]
    }

    case "tool.progress":
      // Keyed STRICTLY by id so concurrently streaming tools never cross-feed.
      // A chunk for an unknown/closed id is dropped: after a reconnect the tool
      // item may not exist (progress is never replayed) and a late chunk must not
      // resurrect text over a finished tool's authoritative output.
      return items.map((it) =>
        it.kind === "tool" && it.id === ev.id && !it.done
          ? { ...it, progress: appendProgress(it.progress, ev.chunk) }
          : it,
      )

    case "tool.end":
      return items.map((it) =>
        it.kind === "tool" && it.id === ev.id
          ? // The final output REPLACES every accumulated progress chunk.
            { ...it, done: true, ok: ev.ok, output: ev.output, progress: undefined }
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
  // Any event routed here is a sign of life: bump the idle clock (and start the
  // elapsed clock if the thread is running but was never spawn-stamped).
  const now = Date.now()
  const next: ThreadNode = {
    ...thread,
    items: fn(thread.items),
    ...(thread.status === "running" ? { startedAt: thread.startedAt ?? now, lastEventAt: now } : {}),
  }
  return { ...state, order, threads: { ...state.threads, [threadId]: next } }
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

    case "context.compacted":
      return updateThreadItems(state, MAIN, (items) => [
        ...items,
        { kind: "compaction-notice", message: "Context compacted — older messages summarized (recall tool can retrieve them)" },
      ])

    case "message.user": {
      // Only cross-session messages render from the event: the user's OWN sends
      // are echoed locally via pushUser (the event would double them), but an
      // injected message has no local echo — the event is its only appearance.
      if (!ev.from) return state
      const threadId = ev.threadId || MAIN
      return updateThreadItems(state, threadId, (items) => [
        ...items,
        { kind: "user", text: ev.text, from: ev.from },
      ])
    }

    case "goal.update": {
      // Goal-mode lifecycle marker on the main thread. `goal` is null when cleared.
      return updateThreadItems(state, MAIN, (items) => [
        ...items,
        { kind: "goal", status: ev.goal?.status ?? "cleared", message: ev.message ?? "Goal updated." },
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
        model: ev.model ?? existing?.model,
        // Anchor the thread at its spawn point in the parent's stream so its block
        // renders inline there. Keep an already-set anchor stable across re-spawns.
        anchorIndex: existing?.anchorIndex ?? state.threads[parentId]?.items.length ?? 0,
        startedAt: existing?.startedAt ?? Date.now(),
        lastEventAt: Date.now(),
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
      const now = Date.now()
      // Running → stamp/refresh the liveness clocks; leaving running → DROP them,
      // so a finished (or replayed) thread renders exactly as it did before.
      const live =
        ev.status === "running"
          ? { startedAt: existing?.startedAt ?? now, lastEventAt: now }
          : { startedAt: undefined, lastEventAt: undefined }
      const node: ThreadNode = existing
        ? { ...existing, status: ev.status, title: ev.title ?? existing.title, ...live }
        : {
            id: ev.threadId,
            parentId: MAIN,
            title: ev.title ?? ev.threadId,
            status: ev.status,
            ...live,
            items: [],
          }
      return {
        ...state,
        order: existing ? state.order : [...state.order, ev.threadId],
        threads: { ...state.threads, [ev.threadId]: node },
      }
    }

    case "workflow.phase": {
      const threadId = ev.threadId || MAIN
      return updateThreadItems(state, threadId, (items) => [...items, { kind: "workflow-phase", title: ev.title }])
    }

    case "workflow.log": {
      const threadId = ev.threadId || MAIN
      return updateThreadItems(state, threadId, (items) => [...items, { kind: "workflow-log", message: ev.message }])
    }

    case "reasoning.start":
    case "reasoning.delta":
    case "reasoning.end":
    case "message.start":
    case "message.delta":
    case "message.end":
    case "tool.start":
    case "tool.progress":
    case "tool.end":
    case "error": {
      const threadId = ("threadId" in ev && ev.threadId) || MAIN
      return updateThreadItems(state, threadId, (items) => reduceItems(items, ev, threadId))
    }

    default:
      return state
  }
}

export function pushUser(state: TranscriptState, text: string, localId?: string): TranscriptState {
  // Strip carriage returns so a raw multi-line echo can't overwrite lines in the
  // terminal (CR returns the cursor to column 0). Pastes normally arrive already
  // collapsed to a chip; this guards the mock/other paths.
  const clean = text.replace(/\r\n?/g, "\n")
  return updateThreadItems(state, MAIN, (items) => [...items, { kind: "user", text: clean, ...(localId ? { localId } : {}) }])
}

/** Undo a just-added local user echo when the server rejects or cannot accept it.
 * The local id distinguishes concurrent sends with identical visible text. */
export function popUser(state: TranscriptState, localId: string): TranscriptState {
  return updateThreadItems(state, MAIN, (items) => {
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i]
      if (item?.kind === "user" && item.localId === localId) return [...items.slice(0, i), ...items.slice(i + 1)]
    }
    return items
  })
}
