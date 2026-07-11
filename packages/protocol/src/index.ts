// @chunky/protocol — the single contract shared by the server and the TUI.
// Both packages import ONLY from here for wire types. Do not fork these shapes.

export const DEFAULT_PORT = 4599

/**
 * Events streamed from server -> client over SSE.
 * The `thread.*` events exist so the TUI can render nested threads later;
 * for the v0 single-thread prototype the server may only ever emit the flat
 * message/tool/session events, but the TUI should tolerate thread events.
 */
/** Token snapshot for one LLM request/turn. Used only to size the prompt cache
 *  (input + cacheRead + cacheWrite ≈ the prompt that must be re-sent on a miss);
 *  cost is intentionally not tracked here. */
export interface UsageDelta {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  /** Model id that produced this usage, when known. */
  model?: string
}

export type AgentEvent =
  | { type: "session.status"; sessionId: string; status: "idle" | "running" }
  /** Emitted at the START of a turn when the prompt cache for this thread is
   * cold — the previous turn's cached prefix is gone, so this turn re-sends the
   * whole context. Either the idle gap exceeded the cache TTL, or the model
   * changed (which invalidates the cache). A cue to start a fresh thread. */
  | {
      type: "cache.warning"
      sessionId: string
      threadId?: string
      reason: "idle" | "model-switch"
      /** Milliseconds since the previous turn's last request (idle reason). */
      idleMs?: number
      /** Approx prompt tokens that will be re-sent (previous turn's context). */
      approxTokens: number
      /** Model of the previous turn / this turn (model-switch reason). */
      fromModel?: string
      toModel?: string
    }
  | { type: "message.start"; role: "assistant"; threadId?: string }
  | { type: "message.delta"; text: string; threadId?: string }
  | { type: "message.end"; threadId?: string }
  | { type: "tool.start"; id: string; name: string; input: unknown; threadId?: string }
  | { type: "tool.end"; id: string; ok: boolean; output: string; threadId?: string }
  | { type: "thread.spawn"; threadId: string; parentThreadId: string | null; title: string }
  | { type: "thread.status"; threadId: string; status: "running" | "idle"; title?: string }
  /** Goal-mode lifecycle: emitted when a goal is set, auto-continues, completes,
   * blocks, or pauses. `goal` is the current snapshot (null once cleared) and
   * `message` is a short human line the TUI renders as a transcript marker. */
  | { type: "goal.update"; sessionId: string; goal: GoalSnapshot | null; message?: string }
  | { type: "error"; message: string; threadId?: string }

/** Lifecycle of a session goal. `active` runs the continuation loop; `paused`
 *  stops it (turn budget hit, interrupted, or user-paused) but keeps the goal;
 *  `blocked`/`complete` are terminal for this objective. */
export type GoalStatus = "active" | "paused" | "blocked" | "complete"

/** The wire snapshot of a session's goal (a subset of the server's stored Goal). */
export interface GoalSnapshot {
  objective: string
  status: GoalStatus
  /** Auto-continuation turns spent so far this run. */
  turns: number
  /** Cap on auto-continuation turns before the goal pauses itself. */
  maxTurns: number
}

// ---- REST shapes ----
export interface CreateSessionResponse {
  sessionId: string
}
export interface SendMessageRequest {
  text: string
}
/** One row in the resume picker: a persisted session the client can reattach to. */
export interface SessionSummary {
  sessionId: string
  title: string
  createdAt: number
  lastActivity: number
}
export interface ListSessionsResponse {
  sessions: SessionSummary[]
}

/** Result of starting a provider login flow. The shape makes it explicit
 * whether the client should open a URL, wait for a provider-opened browser, or
 * stop because credentials are already ready. */
export type LoginInitiation =
  | { kind: "url"; url: string; userCode?: string; instructions: string }
  | { kind: "browser-opened"; instructions: string }
  | { kind: "ready"; instructions: string }

// ---- Endpoints (relative to http://localhost:<port>) ----
export const ROUTES = {
  createSession: `/api/sessions`, // POST -> CreateSessionResponse
  listSessions: `/api/sessions`, // GET  -> ListSessionsResponse (resume picker)
  sendMessage: (id: string) => `/api/sessions/${id}/messages`, // POST SendMessageRequest -> 202
  // POST -> 202. Abort the session's in-flight turn (user interrupt / Esc).
  interrupt: (id: string) => `/api/sessions/${id}/interrupt`,
  // GET -> SSE stream of AgentEvent. Replays persisted history first, so opening
  // this on an existing id IS "resume": the full prior transcript streams, then live.
  events: (id: string) => `/api/sessions/${id}/events`,
  // GET ?q=&limit= -> { items: FileSearchItem[] } — FFF fuzzy search for @-mentions.
  fileSearch: `/api/files/search`,
  // GET  -> GoalStateResponse (current goal, or null).
  // POST GoalRequest -> GoalStateResponse. Set an objective (starts the loop) or
  // run a lifecycle action (pause/resume/clear).
  goal: (id: string) => `/api/sessions/${id}/goal`,
} as const

/** Body for POST ROUTES.goal. Exactly one of `objective` (set + start the goal)
 *  or `action` (manage an existing goal) is expected. */
export interface GoalRequest {
  /** Set this objective and start working toward it. */
  objective?: string
  /** Optional cap on auto-continuation turns (defaults server-side). */
  maxTurns?: number
  /** Lifecycle action on the current goal. */
  action?: "pause" | "resume" | "clear"
}

/** GET/POST ROUTES.goal response: the session's current goal snapshot, or null. */
export interface GoalStateResponse {
  goal: GoalSnapshot | null
}

/** One hit from GET /api/files/search (TUI @-mention autocomplete). */
export interface FileSearchItem {
  path: string
  name: string
  kind: "file" | "directory"
}

export interface FileSearchResponse {
  items: FileSearchItem[]
  totalMatched?: number
  error?: string
}

// ---- SSE helpers (used by BOTH sides) ----

/** Serialize one AgentEvent as an SSE frame. */
export function sse(ev: AgentEvent): string {
  return `data: ${JSON.stringify(ev)}\n\n`
}

/** Parse a fetch() SSE Response body into an async stream of AgentEvent. */
export async function* readSSE(res: Response): AsyncGenerator<AgentEvent> {
  if (!res.body) return
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ""
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let idx: number
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, idx)
      buf = buf.slice(idx + 2)
      const line = frame.split("\n").find((l) => l.startsWith("data:"))
      if (!line) continue
      const json = line.slice(5).trim()
      if (json) {
        try {
          yield JSON.parse(json) as AgentEvent
        } catch {
          /* ignore malformed frame */
        }
      }
    }
  }
}
