// MultiCode CLI server: Bun.serve HTTP + SSE, one model via DeepAgents/Zen.
import { randomUUID } from "node:crypto"
import { DEFAULT_PORT, ROUTES, sse, type AgentEvent } from "@mc/protocol"
import { runAgent } from "./run.ts"

type Subscriber = ReadableStreamDefaultController<Uint8Array>

interface Session {
  subscribers: Set<Subscriber>
  history: AgentEvent[]
}

const sessions = new Map<string, Session>()
const encoder = new TextEncoder()

function emitTo(session: Session, ev: AgentEvent): void {
  session.history.push(ev)
  const frame = encoder.encode(sse(ev))
  for (const controller of session.subscribers) {
    try {
      controller.enqueue(frame)
    } catch {
      // subscriber gone; it will be cleaned up on cancel
    }
  }
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  })
}

const port = Number(process.env.MC_PORT) || DEFAULT_PORT

const server = Bun.serve({
  port,
  idleTimeout: 0, // never time out SSE connections
  async fetch(req) {
    const url = new URL(req.url)
    const { pathname } = url

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS })
    }

    // POST /api/sessions -> { sessionId }
    if (req.method === "POST" && pathname === ROUTES.createSession) {
      const sessionId = randomUUID()
      sessions.set(sessionId, { subscribers: new Set(), history: [] })
      return json({ sessionId })
    }

    // Match /api/sessions/:id/(events|messages)
    const m = pathname.match(/^\/api\/sessions\/([^/]+)\/(events|messages)$/)
    if (m) {
      const [, sessionId, kind] = m
      const session = sessions.get(sessionId)
      if (!session) return json({ error: "unknown session" }, 404)

      // GET .../events -> SSE
      if (kind === "events" && req.method === "GET") {
        let selfController: Subscriber
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            selfController = controller
            // Replay history so a late subscriber sees the full run.
            for (const ev of session.history) {
              controller.enqueue(encoder.encode(sse(ev)))
            }
            session.subscribers.add(controller)
          },
          cancel() {
            session.subscribers.delete(selfController)
          },
        })
        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            ...CORS,
          },
        })
      }

      // POST .../messages { text } -> 202, run agent in background
      if (kind === "messages" && req.method === "POST") {
        let text = ""
        try {
          const body = (await req.json()) as { text?: unknown }
          text = typeof body?.text === "string" ? body.text : ""
        } catch {
          return json({ error: "invalid JSON body" }, 400)
        }
        if (!text) return json({ error: "missing text" }, 400)

        // Fire-and-forget: translate the agent run into events.
        void runAgent(sessionId, text, (ev) => emitTo(session, ev)).catch((err) => {
          emitTo(session, { type: "error", message: (err as Error)?.message ?? String(err) })
          emitTo(session, { type: "session.status", sessionId, status: "idle" })
        })

        return new Response(null, { status: 202, headers: CORS })
      }
    }

    return new Response("not found", { status: 404, headers: CORS })
  },
})

console.log(`[@mc/server] listening on http://localhost:${server.port} (model=${process.env.ZEN_MODEL})`)
