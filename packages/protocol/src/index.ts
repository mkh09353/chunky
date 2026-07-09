// @mc/protocol — the single contract shared by the server and the TUI.
// Both packages import ONLY from here for wire types. Do not fork these shapes.

export const DEFAULT_PORT = 4599

/**
 * Events streamed from server -> client over SSE.
 * The `thread.*` events exist so the TUI can render nested threads later;
 * for the v0 single-thread prototype the server may only ever emit the flat
 * message/tool/session events, but the TUI should tolerate thread events.
 */
export type AgentEvent =
  | { type: "session.status"; sessionId: string; status: "idle" | "running" }
  | { type: "message.start"; role: "assistant"; threadId?: string }
  | { type: "message.delta"; text: string; threadId?: string }
  | { type: "message.end"; threadId?: string }
  | { type: "tool.start"; id: string; name: string; input: unknown; threadId?: string }
  | { type: "tool.end"; id: string; ok: boolean; output: string; threadId?: string }
  | { type: "thread.spawn"; threadId: string; parentThreadId: string | null; title: string }
  | { type: "thread.status"; threadId: string; status: "running" | "idle"; title?: string }
  | { type: "error"; message: string; threadId?: string }

// ---- REST shapes ----
export interface CreateSessionResponse {
  sessionId: string
}
export interface SendMessageRequest {
  text: string
}

// ---- Endpoints (relative to http://localhost:<port>) ----
export const ROUTES = {
  createSession: `/api/sessions`, // POST -> CreateSessionResponse
  sendMessage: (id: string) => `/api/sessions/${id}/messages`, // POST SendMessageRequest -> 202
  events: (id: string) => `/api/sessions/${id}/events`, // GET -> SSE stream of AgentEvent
} as const

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
