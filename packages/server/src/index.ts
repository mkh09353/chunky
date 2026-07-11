// Chunky CLI server: Bun.serve HTTP + SSE. Model via the provider registry;
// sessions + event history persisted to sqlite so reconnecting resumes.
import { randomUUID } from "node:crypto"
import {
  DEFAULT_PORT,
  ROUTES,
  sse,
  type AgentEvent,
  type CacheStatusResponse,
  type GoalRequest,
  type SendBlockedResponse,
} from "@chunky/protocol"
import { runAgent, type InputImage } from "./run.ts"
import { Store } from "./store.ts"
import { DEFAULT_MAX_TURNS, firstLine, goalKickoffPrompt, toSnapshot, type Goal } from "./goal.ts"
import { invalidateAgent } from "./agent.ts"
import {
  activeProviderId,
  activeSelection,
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
import { getAdvisor, setAdvisor, getCacheGuardTokens, setCacheGuardTokens, type AdvisorConfig } from "./settings.ts"
import { cacheColdPayload, checkCacheCold, exceedsGuard } from "./cache-watch.ts"
import { getFinder } from "./fff.ts"
import {
  activeRepo,
  addRepo,
  listRepos,
  removeRepo,
  repoById,
  selectRepo,
} from "./repos.ts"

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

/** Abort any in-flight turn for a session, then start a fresh agent run for
 *  `text`, tracking the AbortController so /interrupt can cancel it. Shared by the
 *  message route and the goal set/resume routes (a goal kickoff is just a run
 *  whose prompt the server supplies). */
function dispatchRun(
  sessionId: string,
  text: string,
  images?: InputImage[],
  options?: { suppressCacheWarning?: boolean },
): void {
  running.get(sessionId)?.abort()
  const ac = new AbortController()
  running.set(sessionId, ac)
  void runAgent(sessionId, text, (ev) => emitTo(sessionId, ev), images, ac, options)
    .catch((err) => {
      emitTo(sessionId, { type: "error", message: (err as Error)?.message ?? String(err) })
      emitTo(sessionId, { type: "session.status", sessionId, status: "idle" })
    })
    .finally(() => {
      if (running.get(sessionId) === ac) running.delete(sessionId)
    })
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
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

    // GET/POST /api/cache-guard -> { tokens } — the confirm-before-resend
    // threshold: a send that would re-send ≥ tokens on a cold prompt cache is
    // refused (409) until confirmed. tokens: null disables the guard.
    if (pathname === ROUTES.cacheGuard) {
      if (req.method === "GET") return json({ tokens: getCacheGuardTokens() })
      if (req.method === "POST") {
        let body: { tokens?: unknown }
        try {
          body = (await req.json()) as typeof body
        } catch {
          return json({ error: "invalid JSON body" }, 400)
        }
        if (body.tokens !== null && typeof body.tokens !== "number") {
          return json({ error: "tokens must be a number or null" }, 400)
        }
        return json({ tokens: setCacheGuardTokens(body.tokens) })
      }
    }

    // GET /api/files/search?q=...&limit=20&repo=<id>
    //   -> { items: [{ path, name, kind: "file"|"directory" }] }
    // FFF-backed fuzzy search for @-mention autocomplete, scoped to one repo's
    // finder (default: the default repo, for clients that don't pass one).
    if (req.method === "GET" && pathname === "/api/files/search") {
      const q = url.searchParams.get("q") ?? ""
      const limitRaw = Number(url.searchParams.get("limit") ?? "20")
      const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(limitRaw, 50)) : 20
      const repoParam = url.searchParams.get("repo")
      const repo = repoParam ? repoById(repoParam) : activeRepo()
      if (repoParam && !repo) return json({ error: `unknown repo "${repoParam}"`, items: [] }, 404)
      try {
        const finder = await getFinder(repo?.path)
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

    // GET /api/repos -> ReposResponse (list of folders + which is active)
    if (req.method === "GET" && pathname === ROUTES.repos) {
      return json(listRepos())
    }

    // POST /api/repos { path } -> add a folder (and make it the default), return the list.
    if (req.method === "POST" && pathname === ROUTES.repos) {
      let body: { path?: unknown }
      try {
        body = (await req.json()) as typeof body
      } catch {
        return json({ error: "invalid JSON body" }, 400)
      }
      const path = typeof body.path === "string" ? body.path.trim() : ""
      if (!path) return json({ error: "missing path" }, 400)
      try {
        const repo = addRepo(path)
        selectRepo(repo.id) // a freshly added repo becomes the default
        return json(listRepos())
      } catch (err) {
        return json({ error: (err as Error)?.message ?? String(err) }, 400)
      }
    }

    // POST /api/repos/:id/select -> persist a repo as the default for repo-less
    // session creation (preference only — never touches in-flight runs).
    // DELETE /api/repos/:id -> remove from the list.
    const repoMatch = pathname.match(/^\/api\/repos\/([^/]+?)(\/select)?$/)
    if (repoMatch) {
      const [, repoId, isSelect] = repoMatch
      if (isSelect && req.method === "POST") {
        if (!repoById(repoId!)) return json({ error: `unknown repo "${repoId}"` }, 404)
        selectRepo(repoId!)
        return json(listRepos())
      }
      if (!isSelect && req.method === "DELETE") {
        return json(removeRepo(repoId!))
      }
    }

    // GET /api/sessions?repo=<id> -> ListSessionsResponse for that repo (or the
    // default one). Threads are scoped per repo so each folder has its own list.
    if (req.method === "GET" && pathname === ROUTES.listSessions) {
      const repoId = url.searchParams.get("repo")
      const repo = repoId ? repoById(repoId) : activeRepo()
      return json({ sessions: Store.list(repo?.path) })
    }

    // POST /api/sessions { repoId? } -> { sessionId }. The session is PINNED to
    // the given repo's workspace at creation (default repo when omitted); every
    // run on it resolves its workspace from the session, so sessions in
    // different repos run concurrently.
    if (req.method === "POST" && pathname === ROUTES.createSession) {
      let repoId: string | undefined
      try {
        const body = (await req.json().catch(() => ({}))) as { repoId?: unknown }
        if (typeof body?.repoId === "string" && body.repoId) repoId = body.repoId
      } catch {
        // no/invalid body -> default repo
      }
      const repo = repoId ? repoById(repoId) : activeRepo()
      if (repoId && !repo) return json({ error: `unknown repo "${repoId}"` }, 404)
      const sessionId = randomUUID()
      Store.createSession(sessionId, undefined, repo?.path)
      subscribers(sessionId) // pre-create the fan-out set
      return json({ sessionId })
    }

    // Match /api/sessions/:id/(events|messages|interrupt|goal|cache)
    const m = pathname.match(/^\/api\/sessions\/([^/]+)\/(events|messages|interrupt|goal|cache)$/)
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

      // GET .../cache -> CacheStatusResponse. Read-only preflight: would a send
      // right now rebuild a cold cache? Lets the TUI warn BEFORE the user sends.
      if (kind === "cache" && req.method === "GET") {
        const model = activeSelection().model
        const cold = model ? checkCacheCold(sessionId, model, Date.now()) : undefined
        return json({
          cold: cold ? cacheColdPayload(cold) : null,
          guardTokens: getCacheGuardTokens(),
        } satisfies CacheStatusResponse)
      }

      // POST .../messages { text, force? } -> 202, run agent in background
      if (kind === "messages" && req.method === "POST") {
        let text = ""
        let force = false
        let images: { base64: string; mediaType: string }[] | undefined
        try {
          const body = (await req.json()) as { text?: unknown; images?: unknown; force?: unknown }
          text = typeof body?.text === "string" ? body.text : ""
          force = body?.force === true
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

        // Cache guard: BEFORE running (or billing) anything, refuse a send that
        // would rebuild a big cold cache. 409 carries the details; the client
        // asks the user and re-POSTs with force: true (or starts a fresh thread).
        if (!force) {
          const model = activeSelection().model
          const guardTokens = getCacheGuardTokens()
          const cold = model ? checkCacheCold(sessionId, model, Date.now()) : undefined
          if (guardTokens != null && exceedsGuard(cold, guardTokens)) {
            return json(
              {
                blocked: "cache-cold",
                warning: cacheColdPayload(cold),
                guardTokens,
              } satisfies SendBlockedResponse,
              409,
            )
          }
        }

        if (text) Store.setTitleIfDefault(sessionId, text) // first message becomes the resume label

        // Echo the user turn into the event stream so it is persisted and
        // replayed on resume (clients render it instead of an optimistic local
        // echo). Emitted before the run so it lands ahead of the assistant reply.
        if (text) emitTo(sessionId, { type: "message.user", text })

        // Abort any prior in-flight turn, then run this one (tracked so /interrupt
        // can cancel it). If a goal is active, runAgent keeps continuing it after.
        // A force-confirmed send skips the redundant turn-start cache notice.
        dispatchRun(sessionId, text, images, { suppressCacheWarning: force })

        return new Response(null, { status: 202, headers: CORS })
      }

      // POST .../interrupt -> abort the session's in-flight turn (Esc).
      if (kind === "interrupt" && req.method === "POST") {
        running.get(sessionId)?.abort()
        return new Response(null, { status: 202, headers: CORS })
      }

      // .../goal — GET the current goal, or POST to set / pause / resume / clear it.
      if (kind === "goal") {
        // GET -> { goal: GoalSnapshot | null }
        if (req.method === "GET") {
          const goal = Store.getGoal(sessionId)
          return json({ goal: goal ? toSnapshot(goal) : null })
        }

        // POST GoalRequest -> { goal: GoalSnapshot | null }
        if (req.method === "POST") {
          let body: GoalRequest
          try {
            body = (await req.json()) as GoalRequest
          } catch {
            return json({ error: "invalid JSON body" }, 400)
          }

          // Set a new objective and immediately start working toward it.
          if (typeof body.objective === "string" && body.objective.trim()) {
            const now = Date.now()
            const maxTurns =
              typeof body.maxTurns === "number" && Number.isFinite(body.maxTurns) && body.maxTurns > 0
                ? Math.floor(body.maxTurns)
                : DEFAULT_MAX_TURNS
            const goal: Goal = {
              sessionId,
              objective: body.objective.trim(),
              status: "active",
              createdAt: now,
              updatedAt: now,
              turns: 0,
              maxTurns,
            }
            Store.putGoal(goal)
            emitTo(sessionId, {
              type: "goal.update",
              sessionId,
              goal: toSnapshot(goal),
              message: `◎ Goal set — ${firstLine(goal.objective)}`,
            })
            dispatchRun(sessionId, goalKickoffPrompt(goal))
            return json({ goal: toSnapshot(goal) })
          }

          // Lifecycle actions on an existing goal.
          if (body.action === "pause") {
            running.get(sessionId)?.abort() // stop the in-flight turn; the loop halts
            const paused = Store.updateGoal(sessionId, { status: "paused" })
            if (paused) {
              emitTo(sessionId, { type: "goal.update", sessionId, goal: toSnapshot(paused), message: "⏸ Goal paused." })
            }
            return json({ goal: paused ? toSnapshot(paused) : null })
          }
          if (body.action === "resume") {
            const existing = Store.getGoal(sessionId)
            if (!existing) return json({ error: "no goal to resume" }, 400)
            // Resume grants a fresh turn budget and dispatches a new run.
            const resumed = Store.updateGoal(sessionId, { status: "active", turns: 0 })!
            emitTo(sessionId, {
              type: "goal.update",
              sessionId,
              goal: toSnapshot(resumed),
              message: `▶ Goal resumed — ${firstLine(resumed.objective)}`,
            })
            dispatchRun(sessionId, goalKickoffPrompt(resumed))
            return json({ goal: toSnapshot(resumed) })
          }
          if (body.action === "clear") {
            running.get(sessionId)?.abort()
            Store.clearGoal(sessionId)
            emitTo(sessionId, { type: "goal.update", sessionId, goal: null, message: "Goal cleared." })
            return json({ goal: null })
          }

          return json({ error: "missing objective or action" }, 400)
        }
      }
    }

    return new Response("not found", { status: 404, headers: CORS })
  },
})

console.log(
  `[@chunky/server] listening on http://localhost:${server.port} (provider=${activeProviderId()})`,
)
