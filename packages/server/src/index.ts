// Chunky CLI server: Bun.serve HTTP + SSE. Model via the provider registry;
// sessions + event history persisted to sqlite so reconnecting resumes.
import { randomUUID } from "node:crypto"
import { DEFAULT_PORT, ROUTES, sse, type AgentEvent } from "@chunky/protocol"
import { runAgent } from "./run.ts"
import { Store } from "./store.ts"
import { invalidateAgent } from "./agent.ts"
import {
  activeProviderId,
  getProvider,
  listModelsFor,
  listProviders,
  resolveAdvisorSelection,
  selectionOf,
  setActiveProviderId,
  setSelection,
  type Effort,
  type Speed,
} from "./providers/registry.ts"
import { getAdvisor, setAdvisor, type AdvisorConfig } from "./settings.ts"
import { getFinder } from "./fff.ts"

type Subscriber = ReadableStreamDefaultController<Uint8Array>

// In-memory fan-out only. Durable history lives in the Store, so this is just
// the set of currently-connected SSE clients per session.
const live = new Map<string, Set<Subscriber>>()
// AbortController for each session's in-flight turn, so /interrupt can cancel it.
const running = new Map<string, AbortController>()
const encoder = new TextEncoder()

function subscribers(sessionId: string): Set<Subscriber> {
  let set = live.get(sessionId)
  if (!set) {
    set = new Set()
    live.set(sessionId, set)
  }
  return set
}

/** Persist an event, then push it to every connected subscriber of the session. */
function emitTo(sessionId: string, ev: AgentEvent): void {
  Store.appendEvent(sessionId, ev)
  const frame = encoder.encode(sse(ev))
  for (const controller of subscribers(sessionId)) {
    try {
      controller.enqueue(frame)
    } catch {
      // subscriber gone; cleaned up on cancel
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

const port = Number(process.env.CHUNKY_PORT) || DEFAULT_PORT

const server = Bun.serve({
  port,
  idleTimeout: 0, // never time out SSE connections
  async fetch(req) {
    const url = new URL(req.url)
    const { pathname } = url

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS })
    }

    // ---- Provider / OAuth routes (additive; independent of sessions) ----

    // GET /api/providers -> { providers: [{ id, label, ready, active }] }
    if (req.method === "GET" && pathname === "/api/providers") {
      const active = activeProviderId()
      return json({
        providers: listProviders().map((p) => ({
          id: p.id,
          label: p.label,
          ready: p.ready(),
          active: p.id === active,
        })),
      })
    }

    // POST /api/auth/:id/login -> { url, userCode?, instructions } (initiate login)
    const loginMatch = pathname.match(/^\/api\/auth\/([^/]+)\/login$/)
    if (loginMatch && req.method === "POST") {
      const id = loginMatch[1]!
      const provider = getProvider(id)
      if (!provider) return json({ error: `unknown provider "${id}"` }, 404)
      if (!provider.login) return json({ error: `provider "${id}" has no login flow` }, 400)
      let method: string | undefined
      try {
        const body = (await req.json().catch(() => ({}))) as { method?: unknown }
        if (typeof body?.method === "string") method = body.method
      } catch {
        // no/invalid body -> default flow
      }
      try {
        const initiation = await provider.login(method)
        return json(initiation)
      } catch (err) {
        return json({ error: (err as Error)?.message ?? String(err) }, 502)
      }
    }

    // GET /api/auth/:id/status -> { ready }
    const statusMatch = pathname.match(/^\/api\/auth\/([^/]+)\/status$/)
    if (statusMatch && req.method === "GET") {
      const id = statusMatch[1]!
      const provider = getProvider(id)
      if (!provider) return json({ error: `unknown provider "${id}"` }, 404)
      return json({ ready: provider.ready() })
    }

    // POST /api/providers/:id/select -> { active } (set active provider for new sessions)
    const selectMatch = pathname.match(/^\/api\/providers\/([^/]+)\/select$/)
    if (selectMatch && req.method === "POST") {
      const id = selectMatch[1]!
      const provider = getProvider(id)
      if (!provider) return json({ error: `unknown provider "${id}"` }, 404)
      setActiveProviderId(id)
      return json({ active: id })
    }

    // GET /api/providers/:id/models -> { models: ModelInfo[] } (fuzzy picker source)
    const modelsMatch = pathname.match(/^\/api\/providers\/([^/]+)\/models$/)
    if (modelsMatch && req.method === "GET") {
      const id = modelsMatch[1]!
      if (!getProvider(id)) return json({ error: `unknown provider "${id}"` }, 404)
      try {
        return json({ models: await listModelsFor(id) })
      } catch (err) {
        return json({ error: (err as Error)?.message ?? String(err) }, 502)
      }
    }

    // GET /api/model -> the current active selection { provider, model, effort?, speed? }
    if (req.method === "GET" && pathname === "/api/model") {
      const provider = activeProviderId()
      const sel = selectionOf(provider)
      return json({ provider, model: sel.model ?? null, effort: sel.effort ?? null, speed: sel.speed ?? null })
    }

    // POST /api/model/select { provider, model, effort?, speed? }
    //   -> persists the selection, makes that provider active, invalidates the
    //      agent cache (so the next turn rebuilds with the new model/knobs), and
    //      returns the now-active selection.
    if (req.method === "POST" && pathname === "/api/model/select") {
      let body: { provider?: unknown; model?: unknown; effort?: unknown; speed?: unknown }
      try {
        body = (await req.json()) as typeof body
      } catch {
        return json({ error: "invalid JSON body" }, 400)
      }
      const provider = typeof body.provider === "string" ? body.provider : ""
      if (!getProvider(provider)) return json({ error: `unknown provider "${provider}"` }, 404)
      const model = typeof body.model === "string" && body.model.length > 0 ? body.model : undefined
      if (!model) return json({ error: "missing model" }, 400)

      const EFFORTS = ["low", "medium", "high", "xhigh"]
      const SPEEDS = ["standard", "fast"]
      const effort =
        typeof body.effort === "string" && EFFORTS.includes(body.effort) ? (body.effort as Effort) : undefined
      const speed =
        typeof body.speed === "string" && SPEEDS.includes(body.speed) ? (body.speed as Speed) : undefined

      setActiveProviderId(provider)
      setSelection(provider, { model, effort, speed })
      invalidateAgent()
      const sel = selectionOf(provider)
      return json({ provider, model: sel.model ?? null, effort: sel.effort ?? null, speed: sel.speed ?? null })
    }

    // GET /api/advisor -> { config, active } (the always-on advisor's config + readiness)
    if (req.method === "GET" && pathname === "/api/advisor") {
      return json({ config: getAdvisor(), active: resolveAdvisorSelection() != null })
    }

    // POST /api/advisor { enabled?, provider?, model?, effort? }
    //   -> merge-persists the advisor config, invalidates the agent cache (so
    //      executors rebuild to add/drop the advisor tool), returns config + active.
    if (req.method === "POST" && pathname === "/api/advisor") {
      let body: { enabled?: unknown; provider?: unknown; model?: unknown; effort?: unknown }
      try {
        body = (await req.json()) as typeof body
      } catch {
        return json({ error: "invalid JSON body" }, 400)
      }
      const EFFORTS = ["low", "medium", "high", "xhigh"]
      const patch: Partial<AdvisorConfig> = {}
      if (typeof body.enabled === "boolean") patch.enabled = body.enabled
      if (typeof body.provider === "string") patch.provider = body.provider
      if (typeof body.model === "string") patch.model = body.model
      if (typeof body.effort === "string" && EFFORTS.includes(body.effort)) patch.effort = body.effort as Effort
      setAdvisor(patch)
      invalidateAgent()
      return json({ config: getAdvisor(), active: resolveAdvisorSelection() != null })
    }

    // GET /api/files/search?q=...&limit=20
    //   -> { items: [{ path, name, kind: "file"|"directory" }] }
    // FFF-backed fuzzy search for the TUI's @-mention autocomplete.
    if (req.method === "GET" && pathname === "/api/files/search") {
      const q = url.searchParams.get("q") ?? ""
      const limitRaw = Number(url.searchParams.get("limit") ?? "20")
      const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(limitRaw, 50)) : 20
      try {
        const finder = await getFinder()
        const result = finder.mixedSearch(q, { pageSize: limit })
        if (!result.ok) return json({ error: result.error, items: [] }, 502)
        const items = result.value.items.slice(0, limit).map((mixed) => {
          if (mixed.type === "directory") {
            return {
              path: mixed.item.relativePath,
              name: mixed.item.dirName,
              kind: "directory" as const,
            }
          }
          return {
            path: mixed.item.relativePath,
            name: mixed.item.fileName,
            kind: "file" as const,
          }
        })
        return json({ items, totalMatched: result.value.totalMatched })
      } catch (err) {
        return json({ error: (err as Error)?.message ?? String(err), items: [] }, 502)
      }
    }

    // GET /api/sessions -> ListSessionsResponse (resume picker)
    if (req.method === "GET" && pathname === ROUTES.listSessions) {
      return json({ sessions: Store.list() })
    }

    // POST /api/sessions -> { sessionId }
    if (req.method === "POST" && pathname === ROUTES.createSession) {
      const sessionId = randomUUID()
      Store.createSession(sessionId)
      subscribers(sessionId) // pre-create the fan-out set
      return json({ sessionId })
    }

    // Match /api/sessions/:id/(events|messages|interrupt)
    const m = pathname.match(/^\/api\/sessions\/([^/]+)\/(events|messages|interrupt)$/)
    if (m) {
      const [, sessionId, kind] = m
      // Accept any session that exists on disk (enables resume across restart),
      // not just ones created in this process.
      if (!Store.exists(sessionId)) return json({ error: "unknown session" }, 404)

      // GET .../events -> SSE. Replays persisted history first (== resume), then live.
      if (kind === "events" && req.method === "GET") {
        let selfController: Subscriber
        let heartbeat: ReturnType<typeof setInterval> | undefined
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            selfController = controller
            for (const ev of Store.history(sessionId)) {
              controller.enqueue(encoder.encode(sse(ev)))
            }
            subscribers(sessionId).add(controller)
            // Heartbeat: an SSE comment every 20s so an otherwise-idle stream keeps
            // bytes flowing. The server never times these out (idleTimeout: 0), but
            // the TUI runs on Bun and Bun's client-side fetch aborts an idle response
            // body after ~5 min ("TimeoutError: The operation timed out"), which is
            // what drops the connection during quiet periods. A comment frame has no
            // `data:` line, so readSSE ignores it — it's purely keep-alive.
            heartbeat = setInterval(() => {
              try {
                controller.enqueue(encoder.encode(": ping\n\n"))
              } catch {
                // controller already closed; cancel() clears the interval
              }
            }, 20_000)
          },
          cancel() {
            if (heartbeat) clearInterval(heartbeat)
            subscribers(sessionId).delete(selfController)
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
        let images: { base64: string; mediaType: string }[] | undefined
        try {
          const body = (await req.json()) as { text?: unknown; images?: unknown }
          text = typeof body?.text === "string" ? body.text : ""
          if (Array.isArray(body?.images)) {
            images = body.images.filter(
              (i): i is { base64: string; mediaType: string } =>
                !!i && typeof i.base64 === "string" && typeof i.mediaType === "string",
            )
          }
        } catch {
          return json({ error: "invalid JSON body" }, 400)
        }
        if (!text && !(images && images.length)) return json({ error: "missing text or image" }, 400)

        if (text) Store.setTitleIfDefault(sessionId, text) // first message becomes the resume label

        // Abort any prior in-flight turn for this session, then track this one so
        // POST /interrupt (Esc in the TUI) can cancel it.
        running.get(sessionId)?.abort()
        const ac = new AbortController()
        running.set(sessionId, ac)

        void runAgent(sessionId, text, (ev) => emitTo(sessionId, ev), images, ac)
          .catch((err) => {
            emitTo(sessionId, { type: "error", message: (err as Error)?.message ?? String(err) })
            emitTo(sessionId, { type: "session.status", sessionId, status: "idle" })
          })
          .finally(() => {
            if (running.get(sessionId) === ac) running.delete(sessionId)
          })

        return new Response(null, { status: 202, headers: CORS })
      }

      // POST .../interrupt -> abort the session's in-flight turn (Esc).
      if (kind === "interrupt" && req.method === "POST") {
        running.get(sessionId)?.abort()
        return new Response(null, { status: 202, headers: CORS })
      }
    }

    return new Response("not found", { status: 404, headers: CORS })
  },
})

console.log(
  `[@chunky/server] listening on http://localhost:${server.port} (provider=${activeProviderId()})`,
)
