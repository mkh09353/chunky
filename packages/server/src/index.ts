// Chunky CLI server: Bun.serve HTTP + SSE. Model via the provider registry;
// sessions + event history persisted to sqlite so reconnecting resumes.
import { randomUUID } from "node:crypto"
import { AsyncLocalStorageProviderSingleton } from "@langchain/core/singletons"
import {
  DEFAULT_PORT,
  ROUTES,
  sse,
  type AgentEvent,
  type CacheStatusResponse,
  type GoalRequest,
  type SendBlockedResponse,
  type ShipRequest,
  type RewindRequest,
  type ForkRequest,
  type ForkResponse,
  type AppBrowserAnnounce,
  type AppBrowserEndpoint,
  type AppBrowserResponse,
} from "@chunky/protocol"
import { effectiveSessionSelection, runAgent, type InputImage, type InterjectionBoundary } from "./run.ts"
import { shipHandoffPrompt } from "./tools/ship.ts"
import { Store } from "./store.ts"
import { restoreSnapshot, snapshotWorkspace } from "./shadow-git.ts"
import { createForkWorktree, removeForkWorktree } from "./worktree-fork.ts"
import { anchorLatestCheckpoint, cloneThreadAtCheckpoint, rewindCheckpoints } from "./bun-sqlite-saver.ts"
import { DEFAULT_MAX_TURNS, firstLine, goalKickoffPrompt, toSnapshot, type Goal } from "./goal.ts"
import { invalidateAgent } from "./agent.ts"
import {
  activeProviderId,
  activeSelection,
  getProvider,
  listAllKnownModelsFor,
  listModelsFor,
  listProviders,
  resolveAdvisorSelection,
  selectionOf,
  setActiveProviderId,
  setSelection,
  type Effort,
  type Speed,
} from "./providers/registry.ts"
import { detectClaudeCredentials } from "./providers/anthropic-sdk.ts"
import { AuthStore } from "./providers/auth-store.ts"
import { checkForUpdate, currentVersion, persistCheck, readPersistedCheck } from "./update/updater.ts"
import { applyOnboardingMode, suggestedModes, ensureDefaultModes, saveCustomProvider } from "./onboarding.ts"
import {
  currentModeSpec,
  deleteMode,
  getAdvisor,
  getCacheGuardTokens,
  getMode,
  getOnboardedAt,
  loadSettings,
  getServerToken,
  getSidekick,
  getSidekickSeats,
  isEffort,
  isValidSeatName,
  listModes,
  resetSidekickSeat,
  saveMode,
  saveCustomProviders,
  setAdvisor,
  setCacheGuardTokens,
  setSidekick,
  setSidekickSeat,
  setSidekickSeats,
  setOnboardedAt,
  setWorkflowTargetOverride,
  agentsMdEnabled,
  setAgentsMdEnabled,
  type AdvisorConfig,
  type ModeSpec,
  type SidekickConfig,
} from "./settings.ts"
import { availableWorkflowTargets } from "./workflow/router.ts"
import { discoverSkills, loadSkill } from "./skills.ts"
import { saveDisabledSkills } from "./settings.ts"
import { drainQueue, installSessionBus } from "./session-bus.ts"
import { InterjectionBuffer, PromptQueue, formatInterjection } from "./prompt-queue.ts"
import { cacheColdPayload, checkCacheCold, exceedsGuard } from "./cache-watch.ts"
import { getFinder } from "./fff.ts"
import {
  activeRepo,
  addRepo,
  listRepos,
  removeRepo,
  repoId,
  repoById,
  selectRepo,
} from "./repos.ts"
import { loadRelayConfig } from "./relay/config.ts"
import { startUplink } from "./relay/uplink.ts"
import { getModelAvailability, manageModelCatalog, setModelAvailability, type ModelCatalogAction } from "./model-catalog.ts"
import { manageSkillRepos, type SkillRepoMutationAction } from "./skill-repos.ts"
import { resetTasks, liveTaskCounts } from "./tasks.ts"
import { installBackgroundDispatcher } from "./background-dispatch.ts"
import { databaseErrorMessage } from "./sqlite.ts"
import {
  canonicalWorkspace,
  removeDiscoveryRecordIfOwned,
  startOwnershipPoller,
  SERVER_IDENTITY_PATH,
  SERVER_LEASES_PATH,
  ServerLeaseTracker,
} from "./launcher-discovery.ts"
import { LAUNCH_WORKSPACE } from "./workspace.ts"
import { getAppBrowserEndpoint, setAppBrowserEndpoint } from "./app-browser.ts"

type Subscriber = ReadableStreamDefaultController<Uint8Array>

// In-memory fan-out only. Durable history lives in the Store, so this is just
// the set of currently-connected SSE clients per session.
const live = new Map<string, Set<Subscriber>>()
// AbortController for each session's in-flight turn, so /interrupt can cancel it.
const running = new Map<string, AbortController>()
// The in-flight turn's completion promise, so a steer can abort the current turn
// and WAIT for it to fully tear down before starting the superseding one — that
// ordering (old idle → message.user → new running) keeps the stream flicker-free.
const runDone = new Map<string, Promise<void>>()
const promptQueues = new Map<string, PromptQueue>()
const interjections = new Map<string, InterjectionBuffer>()
const queueBusy = new Set<string>()
// Bus delivery emits its user event before it asks the bus to dispatch. Keep
// that root-turn identity across the two callbacks.
const busTurns = new Map<string, number[]>()
const encoder = new TextEncoder()

let shuttingDown = false

/** The desktop app's built-in browser pane (CDP endpoint), as announced over
 *  POST ROUTES.appBrowser. Null until an app checks in. Process-local by
 *  design — see the route handler for why this isn't persisted. */
export async function shutdownServer(signal: NodeJS.Signals): Promise<never> {
  if (shuttingDown) return new Promise(() => {})
  shuttingDown = true
  await resetTasks()
  process.removeAllListeners(signal)
  process.kill(process.pid, signal)
  process.exit(128 + (signal === "SIGINT" ? 2 : 15))
  throw new Error("unreachable")
}

process.once("SIGTERM", () => { void shutdownServer("SIGTERM") })
process.once("SIGINT", () => { void shutdownServer("SIGINT") })

function subscribers(sessionId: string): Set<Subscriber> {
  let set = live.get(sessionId)
  if (!set) {
    set = new Set()
    live.set(sessionId, set)
  }
  return set
}

function hasLiveSubscribers(): boolean {
  for (const set of live.values()) if (set.size > 0) return true
  return false
}

/** Persist an event, then push it to every connected subscriber of the session. */
function emitTo(sessionId: string, ev: AgentEvent): void {
  if (ev.type !== "tool.progress" && ev.type !== "session.rewound" && ev.type !== "background.changed") Store.appendEvent(sessionId, ev)
  const frame = encoder.encode(sse(ev))
  for (const controller of subscribers(sessionId)) {
    try {
      controller.enqueue(frame)
    } catch {
      // subscriber gone; cleaned up on cancel
    }
  }
}

/** Reconcile status markers left behind when the process died during a run.
 * The run registry is deliberately in-memory, so a persisted `running` marker
 * is stale whenever this process has no live run for the session.  `history`,
 * when supplied, is also updated so an attach can replay the corrective events
 * without reading the (potentially large) transcript a second time. */
function reconcileStaleRun(sessionId: string, history = Store.history(sessionId)): void {
  if (running.has(sessionId)) return

  let rootStatus: "idle" | "running" | undefined
  const threadStatus = new Map<string, { status: "idle" | "running"; title?: string }>()
  for (const ev of history) {
    if (ev.type === "session.status") {
      rootStatus = ev.status
    } else if (ev.type === "thread.spawn") {
      // A spawn is itself the start marker for child threads.  This also covers
      // older histories (and sidekick handoffs) that have no thread.status yet.
      threadStatus.set(ev.threadId, { status: "running", title: ev.title })
    } else if (ev.type === "thread.status") {
      const current = threadStatus.get(ev.threadId)
      threadStatus.set(ev.threadId, { status: ev.status, title: ev.title ?? current?.title })
    }
  }

  // Check immediately before each append as well as at entry.  These operations
  // are synchronous today, but this preserves the invariant if the persistence
  // path or run dispatching changes later.
  if (rootStatus === "running" && !running.has(sessionId)) {
    const correction: AgentEvent = { type: "session.status", sessionId, status: "idle" }
    emitTo(sessionId, correction)
    history.push(correction)
  }
  for (const [threadId, state] of threadStatus) {
    if (state.status !== "running" || running.has(sessionId)) continue
    const correction: AgentEvent = {
      type: "thread.status",
      threadId,
      status: "idle",
      ...(state.title ? { title: state.title } : {}),
    }
    emitTo(sessionId, correction)
    history.push(correction)
  }
}

/** Start an agent run for `text` WITHOUT touching any in-flight turn, tracking
 *  the AbortController so /interrupt can cancel it. Resolves when the run fully
 *  completes (the session bus awaits this for wait_for_reply). When the run
 *  ends, any messages other sessions queued behind it are delivered. */
function startRun(
  sessionId: string,
  text: string,
  images?: InputImage[],
  options?: { suppressCacheWarning?: boolean },
  turn?: number,
): Promise<void> {
  const ac = new AbortController()
  running.set(sessionId, ac)
  const done = runAgent(sessionId, text, (ev) => emitTo(sessionId, ev), images, ac, {
    ...options,
    onToolBoundary: (): InterjectionBoundary | undefined => {
      const notes = interjections.get(sessionId)?.drainAll() ?? []
      return notes.length ? {
        prompts: notes.map((note) => formatInterjection(note.text)),
        texts: notes.map((note) => note.text),
        images: notes.map((note) => note.images?.map((image) => ({ base64: image.base64, mediaType: image.mediaType }))),
      } : undefined
    },
  })
    .catch((err) => {
      emitTo(sessionId, { type: "error", message: databaseErrorMessage(err) })
      emitTo(sessionId, { type: "session.status", sessionId, status: "idle" })
    })
    .finally(() => {
      if (turn != null) Store.completeTurn(sessionId, turn, anchorLatestCheckpoint(sessionId, turn))
      if (running.get(sessionId) === ac) running.delete(sessionId)
      if (runDone.get(sessionId) === done) runDone.delete(sessionId)
      drainQueue(sessionId)
      queueBusy.delete(sessionId)
      const leftovers = interjections.get(sessionId)?.drainAll() ?? []
      if (leftovers.length) {
        const queue = promptQueues.get(sessionId) ?? new PromptQueue()
        for (const note of leftovers) {
          try { queue.enqueue({ prompt: formatInterjection(note.text), shown: note.text, images: note.images, kind: "interject" }) }
          catch { emitTo(sessionId, { type: "error", message: "interjection queue is full; message discarded" }); break }
        }
        promptQueues.set(sessionId, queue)
      }
      if (!running.has(sessionId)) {
        const next = promptQueues.get(sessionId)?.shift()
        if (next) {
          queueBusy.add(sessionId)
          emitTo(sessionId, { type: "queue.changed", sessionId, entries: promptQueues.get(sessionId)?.snapshot() ?? [], running: false })
          const nextTurn = beginUserTurn(sessionId, next.shown)
          emitTo(sessionId, { type: "message.user", text: next.shown })
          void startRun(sessionId, next.prompt, next.images, undefined, nextTurn)
        } else {
          emitTo(sessionId, { type: "queue.changed", sessionId, entries: [], running: false })
        }
      }
    })
  runDone.set(sessionId, done)
  return done
}

/** Abort the session's in-flight turn as a STEER (reason "steer", so the run
 *  reports no interrupt and doesn't pause its goal) and wait for it to fully tear
 *  down. No-op when nothing is running. */
async function abortForSteer(sessionId: string): Promise<void> {
  const ac = running.get(sessionId)
  if (!ac) return
  ac.abort("steer")
  await runDone.get(sessionId)?.catch(() => {})
}

/** Abort any in-flight turn for a session, then start a fresh agent run.
 *  Shared by the message route and the goal set/resume routes (a goal kickoff
 *  is just a run whose prompt the server supplies). */
function dispatchRun(
  sessionId: string,
  text: string,
  images?: InputImage[],
  options?: { suppressCacheWarning?: boolean },
  turn?: number,
): void {
  running.get(sessionId)?.abort()
  void startRun(sessionId, text, images, options, turn)
}

/** Record a visible root user turn before its transcript event so rewind can
 * remove that event and everything after it. Snapshot failure is intentional
 * degradation: the agent still runs, but that point is unavailable to rewind. */
function beginUserTurn(sessionId: string, text: string): number {
  const workspace = Store.workspaceOf(sessionId) ?? LAUNCH_WORKSPACE
  const snapshot = snapshotWorkspace(workspace, `refs/sessions/${sessionId}`)
  return Store.startTurn(sessionId, text, snapshot)
}

function sessionIsBusy(sessionId: string): boolean {
  const activeChildren = new Map<string, boolean>()
  for (const ev of Store.history(sessionId)) {
    if (ev.type === "thread.spawn") activeChildren.set(ev.threadId, true)
    if (ev.type === "thread.status") activeChildren.set(ev.threadId, ev.status === "running")
  }
  return running.has(sessionId) || [...activeChildren.values()].some(Boolean)
}


// Wire the inter-session tools (list_sessions / send_to_session) to this
// module's run machinery. Bus deliveries never abort in-flight turns — they
// queue behind them (see session-bus.ts).
installSessionBus({
  emitUserMessage(sessionId, text, from) {
    const turn = beginUserTurn(sessionId, text)
    const turns = busTurns.get(sessionId) ?? []
    turns.push(turn)
    busTurns.set(sessionId, turns)
    emitTo(sessionId, { type: "message.user", text, from })
  },
  emitEvent(sessionId, ev) {
    emitTo(sessionId, ev)
  },
  dispatch(sessionId, text) {
    // A bus delivery can originate INSIDE another session's tool call
    // (send_to_session, ship_goal). Run the new session's turn on a CLEARED
    // async-local store so its LLM tokens stream only through its own
    // iterator — not into the sender's `messages` stream via the ambient
    // callback context (same isolation as ThreadManager.spawn).
    const turn = busTurns.get(sessionId)?.shift()
    return AsyncLocalStorageProviderSingleton.getInstance().run(undefined, () => startRun(sessionId, text, undefined, undefined, turn))
  },
  isRunning(sessionId) {
    return running.has(sessionId)
  },
})

// Background tasks must not inherit an ambient tool-call AsyncLocalStorage
// context: their wake turns belong exclusively to their owning session.
installBackgroundDispatcher({
  isRunning: (sessionId) => running.has(sessionId),
  wake(sessionId, prompt, shownText) {
    const turn = beginUserTurn(sessionId, shownText)
    emitTo(sessionId, { type: "message.user", text: shownText, from: "monitor" })
    void AsyncLocalStorageProviderSingleton.getInstance().run(undefined, () => startRun(sessionId, prompt, undefined, undefined, turn))
  },
  changed(sessionId) { emitTo(sessionId, { type: "background.changed", sessionId, ...liveTaskCounts(sessionId) }) },
})

const ALLOWED_ORIGINS = new Set(["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:4620", "http://127.0.0.1:4620", "views://mainview"])
function corsHeaders(req?: Request): Record<string, string> {
  const origin = req?.headers.get("origin")
  return {
    ...(origin && ALLOWED_ORIGINS.has(origin) ? { "Access-Control-Allow-Origin": origin, "Vary": "Origin" } : {}),
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  }
}

function json(body: unknown, status = 200, req?: Request): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(req) },
  })
}

const port = Number(process.env.CHUNKY_PORT) || DEFAULT_PORT
const launcherManaged = !!process.env.CHUNKY_SERVER_NONCE
const serverLeases = launcherManaged ? new ServerLeaseTracker(() => Date.now(), 30_000, 30_000) : null

// This is deliberately fire-and-forget: a GitHub outage must never affect boot.
const previousUpdateCheck = readPersistedCheck()
// Re-check immediately if the persisted result predates the running version
// (i.e. we just updated), not only when it is older than 24h.
if (!previousUpdateCheck?.checkedAt || previousUpdateCheck.current !== currentVersion() || Date.now() - previousUpdateCheck.checkedAt >= 24 * 60 * 60 * 1000) {
  void checkForUpdate().then(persistCheck).catch(() => {})
}

const server = Bun.serve({
  port,
  idleTimeout: 0, // never time out SSE connections
  async fetch(req, server) {
    // Authenticate every request, including loopback. Query-token auth keeps
    // native EventSource-compatible clients working when headers are limited.
    const requestUrl = new URL(req.url)
    const origin = req.headers.get("origin")
    if (origin && !ALLOWED_ORIGINS.has(origin)) return json({ error: "origin not allowed" }, 403, req)
    // This managed-server discovery response contains only public identity
    // metadata (workspace name, version/build identifiers, port, and nonce),
    // never credentials or session data. Keep it readable by the launcher so
    // it can discover an existing server before it has loaded its settings.
    if (req.method === "GET" && requestUrl.pathname === SERVER_IDENTITY_PATH) {
      const workspace = process.env.CHUNKY_WORKSPACE
      const version = process.env.CHUNKY_VERSION
      const buildId = process.env.CHUNKY_BUILD_ID
      const nonce = process.env.CHUNKY_SERVER_NONCE
      const id = process.env.CHUNKY_SERVER_ID
      if (!workspace || !version || !buildId || !nonce || !id) return json({ error: "launcher identity unavailable" }, 404)
      return json({ workspace, version, buildId, nonce, id, port: server.port })
    }
    // CORS preflight cannot carry the actual bearer header. It is harmless on
    // its own (no application route is dispatched) and lets real webviews make
    // the subsequent authenticated request.
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(req) })
    const token = getServerToken()
    if (req.headers.get("authorization") !== `Bearer ${token}` && requestUrl.searchParams.get("token") !== token) return json({ error: "unauthorized" }, 401, req)

    const url = requestUrl
    const { pathname } = url

    if (pathname === SERVER_LEASES_PATH && serverLeases && (req.method === "POST" || req.method === "DELETE")) {
      const body = await req.json().catch(() => null) as { token?: unknown } | null
      if (!body || typeof body.token !== "string" || !body.token) return json({ error: "missing lease token" }, 400)
      if (req.method === "POST") serverLeases.attach(body.token)
      else serverLeases.release(body.token)
      return json({ leases: serverLeases.size })
    }

    if (req.method === "GET" && pathname === ROUTES.updateStatus) {
      // A record persisted by an older build (e.g. before `chunky update`) may
      // claim a version we already run — never surface that as an update.
      const check = readPersistedCheck()
      if (!check || check.current !== currentVersion()) return json({ current: currentVersion(), latest: null, available: false })
      return json(check)
    }

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(req) })
    }

    // ---- Provider / OAuth routes (additive; independent of sessions) ----

    if (req.method === "GET" && pathname === ROUTES.onboarding) {
      const detected = detectClaudeCredentials()
      const statuses = listProviders().map((provider) => {
        if (provider.id === "anthropic") {
          return { id: provider.id, label: provider.label,
            status: detected.state === "ready" ? "inherited" : "missing", detail: detected.detail }
        }
        return { id: provider.id, label: provider.label,
          status: provider.ready() ? "ready" : "missing",
          ...(provider.ready() ? {} : { detail: "No credentials configured." }) }
      })
      const ready = new Set(statuses.filter((p) => p.status !== "missing").map((p) => p.id))
      return json({ providers: statuses, onboardedAt: getOnboardedAt(), suggestedModes: await suggestedModes(ready) })
    }
    if (req.method === "POST" && pathname === ROUTES.onboardingApply) {
      const body = await req.json().catch(() => null) as { mode?: ModeSpec; name?: string } | null
      const spec = body?.mode
      if (!spec?.provider || !spec.model) return json({ error: "mode provider and model are required" }, 400)
      const name = body?.name?.trim() || "default"
      if (!/^[\w+.-]{1,40}$/.test(name)) return json({ error: "invalid mode name" }, 400)
      try { applyOnboardingMode(name, spec) } catch (err) { return json({ error: (err as Error).message }, 404) }
      return json({ applied: name, spec })
    }
    if (req.method === "POST" && pathname === ROUTES.customProvider) {
      const body = await req.json().catch(() => null) as { id?: string; label?: string; baseURL?: string; billing?: "subscription" | "metered"; defaultModel?: string; key?: string } | null
      if (!body?.id || !body.label || !body.baseURL || !body.key) return json({ error: "id, label, baseURL, and key are required" }, 400)
      try { return json(saveCustomProvider({ id: body.id, label: body.label, baseURL: body.baseURL, billing: body.billing, defaultModel: body.defaultModel, key: body.key })) }
      catch (err) { return json({ error: (err as Error).message }, 400) }
    }
    if (req.method === "POST" && pathname === ROUTES.onboardingComplete) {
      return json({ onboardedAt: setOnboardedAt() })
    }

    // GET /api/providers -> { providers: [{ id, label, ready, active }] }
    if (req.method === "GET" && pathname === "/api/providers") {
      const active = activeProviderId()
      return json({
        providers: listProviders().map((p) => ({
          id: p.id,
          label: p.label,
          billing: p.billing,
          ready: p.ready(),
          active: p.id === active,
        })),
      })
    }

    if (req.method === "GET" && pathname === "/api/usage") {
      const session = new URL(req.url).searchParams.get("session")
      if (!session) return json({ error: "session is required" }, 400)
      const roles = Store.usageRows(session).map((r) => ({ role: r.role, provider: r.provider, model: r.model,
        effort: r.effort ?? null, inputTokens: r.inputTokens ?? 0, outputTokens: r.outputTokens ?? 0,
        reasoningTokens: r.reasoningTokens ?? 0, cacheReadTokens: r.cacheReadTokens ?? 0,
        cacheWriteTokens: r.cacheWriteTokens ?? 0, cost: r.cost == null ? null : Number(r.cost), requests: r.requests }))
      const known = roles.every((r) => r.cost != null)
      return json({ roles, totals: { inputTokens: roles.reduce((n, r) => n + r.inputTokens, 0), outputTokens: roles.reduce((n, r) => n + r.outputTokens, 0), cost: known ? roles.reduce((n, r) => n + (r.cost ?? 0), 0) : null } })
    }
    if (req.method === "GET" && pathname === "/api/scoreboard") {
      const session = new URL(req.url).searchParams.get("session") ?? undefined
      return json({ rows: Store.scoreboardRows(session).map((r) => {
        const cost = r.totalCost == null ? null : Number(r.totalCost), avg = r.avgRating == null ? null : Number(r.avgRating)
        return { provider: r.provider, model: r.model, effort: r.effort ?? null, kind: r.kind, samples: r.samples, avgRating: avg,
          ratedCount: r.ratedCount, reworkRate: r.reworkRate == null ? null : Number(r.reworkRate), totalCost: cost, totalTokens: r.totalTokens ?? 0,
          ratingPerDollar: avg != null && cost != null && cost > 0 ? avg / (cost / r.samples) : null }
      }) })
    }

    // Workflow worker routing: zero-config effective targets plus optional user exceptions.
    if (pathname === "/api/workflow-targets" && req.method === "GET") {
      return json({ targets: await availableWorkflowTargets() })
    }
    if (pathname === "/api/workflow-targets" && (req.method === "PUT" || req.method === "DELETE")) {
      try {
        const body = (await req.json()) as {
          provider?: string
          model?: string
          tags?: unknown
          automatic?: unknown
          effort?: Effort
        }
        if (!body.provider || !body.model) return json({ error: "provider and model are required" }, 400)
        const workflowProvider = getProvider(body.provider)
        if (!workflowProvider) return json({ error: `unknown provider "${body.provider}"` }, 404)
        if (req.method === "PUT" && workflowProvider.ready()) {
          const known = await listAllKnownModelsFor(body.provider)
          if (!known.some((model) => model.id === body.model)) {
            return json({ error: `unknown model "${body.model}" for provider "${body.provider}"` }, 404)
          }
        }
        if (req.method === "DELETE") {
          setWorkflowTargetOverride(body.provider, body.model, null)
        } else {
          if (body.tags !== undefined && (!Array.isArray(body.tags) || body.tags.some((tag) => typeof tag !== "string"))) {
            return json({ error: "tags must be an array of strings" }, 400)
          }
          if (body.automatic !== undefined && typeof body.automatic !== "boolean") {
            return json({ error: "automatic must be a boolean" }, 400)
          }
          if (body.effort !== undefined && !isEffort(body.effort)) {
            return json({ error: "effort must be low, medium, high, xhigh, or max" }, 400)
          }
          setWorkflowTargetOverride(body.provider, body.model, {
            ...(body.tags !== undefined ? { tags: body.tags as string[] } : {}),
            ...(body.automatic !== undefined ? { automatic: body.automatic } : {}),
            ...(body.effort !== undefined ? { effort: body.effort } : {}),
          })
        }
        return json({ ok: true })
      } catch (err) {
        return json({ error: (err as Error).message }, 400)
      }
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

    // Complete model catalog + checked availability, including hidden models.
    const availabilityMatch = pathname.match(/^\/api\/providers\/([^/]+)\/models\/availability$/)
    if (availabilityMatch && req.method === "GET") {
      try {
        return json(await getModelAvailability(availabilityMatch[1]!))
      } catch (err) {
        return json({ error: (err as Error)?.message ?? String(err) }, 400)
      }
    }
    if (availabilityMatch && req.method === "PUT") {
      try {
        const body = (await req.json()) as { available?: unknown }
        return json(await setModelAvailability(availabilityMatch[1]!, body.available))
      } catch (err) {
        return json({ error: (err as Error)?.message ?? String(err) }, 400)
      }
    }

    // POST /api/providers/:id/models/catalog — live persistent add/hide/restore.
    const catalogMatch = pathname.match(/^\/api\/providers\/([^/]+)\/models\/catalog$/)
    if (catalogMatch && req.method === "POST") {
      const provider = catalogMatch[1]!
      try {
        const body = (await req.json()) as { action?: ModelCatalogAction; model?: string }
        if (!body.action || !["add", "hide", "restore", "list"].includes(body.action)) {
          return json({ error: "action must be add, hide, restore, or list" }, 400)
        }
        return json(await manageModelCatalog(body.action, provider, body.model))
      } catch (err) {
        return json({ error: (err as Error)?.message ?? String(err) }, 400)
      }
    }

    // GET lists managed skill packs and their enabled skills; POST mutates a
    // repository or an individual skill. Kept structured for both desktop UI
    // and TUI manager (the agent uses the same underlying service directly).
    if (pathname === "/api/skill-repos" && (req.method === "GET" || req.method === "POST")) {
      try {
        if (req.method === "GET") return json(await manageSkillRepos("list"))
        const body = (await req.json()) as { action?: SkillRepoMutationAction; url?: string; id?: string; branch?: string; subdir?: string; skill?: string }
        if (!body.action || !["add", "remove", "update", "list", "enable", "disable"].includes(body.action)) {
          return json({ error: "action must be add, remove, update, list, enable, or disable" }, 400)
        }
        return json(await manageSkillRepos(body.action, body))
      } catch (err) {
        return json({ error: (err as Error).message }, 400)
      }
    }

    // The desktop app's built-in browser pane announces its CDP endpoint here on
    // startup, and agent tooling reads it back to drive that pane.
    //
    // In-memory and last-writer-wins on purpose: the endpoint is only meaningful
    // while that app process is alive, so persisting it would hand out a dead
    // port after a restart. If two apps point at one server, the most recent
    // announcement wins — which is also the one the user is looking at.
    if (pathname === ROUTES.appBrowser && (req.method === "GET" || req.method === "POST")) {
      if (req.method === "GET") return json({ browser: getAppBrowserEndpoint() } satisfies AppBrowserResponse)
      const body = (await req.json().catch(() => ({}))) as Partial<AppBrowserAnnounce>
      try { return json({ browser: setAppBrowserEndpoint(body as AppBrowserAnnounce) } satisfies AppBrowserResponse) }
      catch (err) { return json({ error: (err as Error).message }, 400) }
    }

    if (pathname === "/api/skills" && req.method === "GET") {
      const session = url.searchParams.get("session")
      const workspace = session && Store.exists(session) ? Store.workspaceOf(session) : url.searchParams.get("workspace")
      const skills = workspace ? discoverSkills(workspace, { includeDisabled: true }) : discoverSkills(process.cwd(), { includeDisabled: true }).filter((s) => s.source !== "project")
      return json({ skills: skills.map((s) => ({ name: s.name, description: s.description, source: s.source, sourceLabel: s.sourceLabel, path: s.path, enabled: s.enabled !== false })) })
    }
    if (pathname === "/api/skills" && req.method === "POST") {
      const body = await req.json().catch(() => ({})) as { action?: "enable" | "disable"; name?: string; repoId?: string }
      if (!body.action || !body.name) return json({ error: "action and name are required" }, 400)
      if (body.repoId) {
        const { manageSkillRepos } = await import("./skill-repos.ts")
        return json(await manageSkillRepos(body.action, { id: body.repoId, skill: body.name }))
      }
      const disabled = new Set(loadSettings().disabledSkills ?? [])
      body.action === "disable" ? disabled.add(body.name) : disabled.delete(body.name)
      saveDisabledSkills([...disabled])
      return json({ action: body.action, name: body.name, enabled: body.action === "enable" })
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

      const EFFORTS = ["low", "medium", "high", "xhigh", "max"]
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
      const EFFORTS = ["low", "medium", "high", "xhigh", "max"]
      const patch: Partial<AdvisorConfig> = {}
      if (typeof body.enabled === "boolean") patch.enabled = body.enabled
      if (typeof body.provider === "string") patch.provider = body.provider
      if (typeof body.model === "string") patch.model = body.model
      if (typeof body.effort === "string" && EFFORTS.includes(body.effort)) patch.effort = body.effort as Effort
      setAdvisor(patch)
      invalidateAgent()
      return json({ config: getAdvisor(), active: resolveAdvisorSelection() != null })
    }

    // GET /api/sidekick -> { config, seats } (the default seat + master switch,
    // plus the named domain seats; an unconfigured-but-enabled default seat
    // inherits the active selection, so there is no separate "active" readiness)
    if (req.method === "GET" && pathname === "/api/sidekick") {
      return json({ config: getSidekick(), seats: getSidekickSeats() })
    }

    // POST /api/sidekick { enabled?, provider?, model?, effort?, seat? }
    //   -> no `seat`: merge-persists the DEFAULT seat config.
    //      `seat: "<name>"`: sets that NAMED seat (enabled:false deletes it).
    //   Either way invalidates the agent cache (executors rebuild so the tool,
    //   prompt seat list, and per-seat threads stay current).
    if (req.method === "POST" && pathname === "/api/sidekick") {
      let body: { enabled?: unknown; provider?: unknown; model?: unknown; effort?: unknown; seat?: unknown }
      try {
        body = (await req.json()) as typeof body
      } catch {
        return json({ error: "invalid JSON body" }, 400)
      }
      const EFFORTS = ["low", "medium", "high", "xhigh", "max"]
      if (typeof body.seat === "string") {
        const name = body.seat.trim().toLowerCase()
        if (!isValidSeatName(name)) {
          return json({ error: `invalid seat name "${name}" — short lowercase slug, not "default"` }, 400)
        }
        if (body.enabled === false) {
          setSidekickSeat(name, null)
        } else {
          if (typeof body.provider !== "string" || typeof body.model !== "string") {
            return json({ error: "a named seat needs provider and model" }, 400)
          }
          setSidekickSeat(name, {
            provider: body.provider,
            model: body.model,
            ...(typeof body.effort === "string" && EFFORTS.includes(body.effort) ? { effort: body.effort as Effort } : {}),
          })
        }
        invalidateAgent()
        return json({ config: getSidekick(), seats: getSidekickSeats() })
      }
      const patch: Partial<SidekickConfig> = {}
      if (typeof body.enabled === "boolean") patch.enabled = body.enabled
      if (typeof body.provider === "string") patch.provider = body.provider
      if (typeof body.model === "string") patch.model = body.model
      if (typeof body.effort === "string" && EFFORTS.includes(body.effort)) patch.effort = body.effort as Effort
      setSidekick(patch)
      invalidateAgent()
      return json({ config: getSidekick(), seats: getSidekickSeats() })
    }

    // ---- Modes: named executor+advisor pairings (GET/POST /api/modes,
    // POST /api/modes/:name/apply, DELETE /api/modes/:name) ----

    // GET -> ModesResponse (saved modes + the current, possibly unsaved, pairing).
    if (req.method === "GET" && pathname === ROUTES.modes) {
      const ready = new Set(listProviders().filter((p) => p.ready()).map((p) => p.id))
      await ensureDefaultModes(ready)
      return json({ modes: listModes(), current: currentModeSpec() })
    }

    // POST { name, spec? } -> save a mode. Omitted spec snapshots the CURRENT
    // executor+advisor pairing under that name.
    if (req.method === "POST" && pathname === ROUTES.modes) {
      let body: { name?: unknown; spec?: unknown }
      try {
        body = (await req.json()) as typeof body
      } catch {
        return json({ error: "invalid JSON body" }, 400)
      }
      const name = typeof body.name === "string" ? body.name.trim() : ""
      if (!/^[\w+.-]{1,40}$/.test(name)) {
        return json({ error: "mode name must be 1-40 chars of letters, digits, _ + . -" }, 400)
      }
      const spec = (body.spec as ModeSpec | undefined) ?? currentModeSpec()
      if (!spec.provider || !spec.model) {
        return json({ error: "no model selected — pick one with /model before saving a mode" }, 400)
      }
      if (!getProvider(spec.provider)) return json({ error: `unknown provider "${spec.provider}"` }, 404)
      saveMode(name, spec)
      return json({ modes: listModes(), current: currentModeSpec() })
    }

    // POST /api/modes/:name/apply -> set executor + advisor as one unit.
    // DELETE /api/modes/:name -> remove it.
    const modeMatch = pathname.match(/^\/api\/modes\/([^/]+?)(\/apply)?$/)
    if (modeMatch && pathname !== ROUTES.modes) {
      const name = decodeURIComponent(modeMatch[1]!)
      const isApply = Boolean(modeMatch[2])
      if (isApply && req.method === "POST") {
        const spec = getMode(name)
        if (!spec) return json({ error: `unknown mode "${name}"` }, 404)
        if (!getProvider(spec.provider)) return json({ error: `mode "${name}" uses unknown provider "${spec.provider}"` }, 400)
        setActiveProviderId(spec.provider)
        setSelection(spec.provider, { model: spec.model, effort: spec.effort, speed: spec.speed })
        if (spec.advisor) {
          setAdvisor({ enabled: true, provider: spec.advisor.provider, model: spec.advisor.model, effort: spec.advisor.effort })
        } else {
          setAdvisor({ enabled: false })
        }
        // The sidekick seat is part of the trio, but only when the mode names
        // one — a mode saved before sidekicks existed (spec.sidekick undefined)
        // leaves the current seat alone; an explicit null resets to inherit.
        if (spec.sidekick) {
          setSidekick({ enabled: true, provider: spec.sidekick.provider, model: spec.sidekick.model, effort: spec.sidekick.effort })
        } else if (spec.sidekick === null) {
          resetSidekickSeat()
        }
        // Same absent/null contract for the NAMED seats: absent = leave alone.
        if (spec.sidekickSeats) {
          setSidekickSeats(spec.sidekickSeats)
        } else if (spec.sidekickSeats === null) {
          setSidekickSeats({})
        }
        invalidateAgent()
        const sel = selectionOf(spec.provider)
        return json({
          applied: name,
          provider: spec.provider,
          model: sel.model ?? null,
          effort: sel.effort ?? null,
          speed: sel.speed ?? null,
          advisor: getAdvisor(),
          advisorActive: resolveAdvisorSelection() != null,
          sidekick: getSidekick(),
          sidekickSeats: getSidekickSeats(),
        })
      }
      if (!isApply && req.method === "DELETE") {
        if (!deleteMode(name)) return json({ error: `unknown mode "${name}"` }, 404)
        return json({ modes: listModes(), current: currentModeSpec() })
      }
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

    const instructionsMatch = pathname.match(/^\/api\/repos\/([^/]+)\/instructions$/)
    if (instructionsMatch) {
      const repo = repoById(instructionsMatch[1]!)
      if (!repo) return json({ error: `unknown repo "${instructionsMatch[1]}"` }, 404)
      if (req.method === "GET") return json({ enabled: agentsMdEnabled(repo.id) })
      if (req.method === "POST") {
        let body: { enabled?: unknown }
        try { body = (await req.json()) as typeof body } catch { return json({ error: "invalid JSON body" }, 400) }
        if (typeof body.enabled !== "boolean") return json({ error: "enabled must be boolean" }, 400)
        return json({ enabled: setAgentsMdEnabled(repo.id, body.enabled) })
      }
    }

    // GET /api/sessions?repo=<id> -> ListSessionsResponse for that repo (or the
    // default one). Threads are scoped per repo so each folder has its own list.
    if (req.method === "GET" && pathname === ROUTES.listSessions) {
      const repoId = url.searchParams.get("repo")
      const repo = repoId ? repoById(repoId) : activeRepo()
      const cwd = url.searchParams.get("cwd")
      const sessions = Store.list(cwd ? canonicalWorkspace(cwd) : repo?.path).map((session) => ({
        ...session,
        attached: (live.get(session.sessionId)?.size ?? 0) > 0,
      }))
      return json({ sessions })
    }

    if (req.method === "GET" && pathname === ROUTES.serverInfo) {
      return json({ workspace: canonicalWorkspace(process.env.CHUNKY_WORKSPACE || LAUNCH_WORKSPACE) })
    }

    // POST /api/sessions { repoId? } -> { sessionId }. The session is PINNED to
    // the given repo's workspace at creation (default repo when omitted); every
    // run on it resolves its workspace from the session, so sessions in
    // different repos run concurrently.
    if (req.method === "POST" && pathname === ROUTES.createSession) {
      let repoId: string | undefined
      try {
        const body = (await req.json().catch(() => ({}))) as { repoId?: unknown; cwd?: unknown }
        if (typeof body?.repoId === "string" && body.repoId) repoId = body.repoId
        var clientCwd = typeof body?.cwd === "string" && body.cwd ? canonicalWorkspace(body.cwd) : undefined
      } catch {
        // no/invalid body -> default repo
      }
      const repo = repoId ? repoById(repoId) : activeRepo()
      if (repoId && !repo) return json({ error: `unknown repo "${repoId}"` }, 404)
      const sessionId = randomUUID()
      Store.createSession(sessionId, undefined, clientCwd ?? repo?.path)
      // Warm FFF without delaying session creation; FileFinder's native watcher
      // keeps the index incrementally current. Its public API has no manual
      // update/rescan hook, so do not add a redundant JS watcher.
      void getFinder(repo?.path).catch(() => {})
      subscribers(sessionId) // pre-create the fan-out set
      return json({ sessionId })
    }

    // PATCH /api/sessions/:id { title } -> rename a session. Session deletion
    // is intentionally not supported.
    const renameMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/)
    if (renameMatch && req.method === "PATCH") {
      const sessionId = renameMatch[1]
      if (!Store.exists(sessionId)) return json({ error: "unknown session" }, 404)
      let body: { title?: unknown }
      try {
        body = (await req.json()) as typeof body
      } catch {
        return json({ error: "invalid JSON body" }, 400)
      }
      if (typeof body.title !== "string" || !body.title.trim()) {
        return json({ error: "title must not be empty" }, 400)
      }
      Store.setTitle(sessionId, body.title.trim().slice(0, 200))
      return json({ ok: true })
    }

    // Match /api/sessions/:id/(events|messages|interrupt|goal|ship|cache)
    const m = pathname.match(/^\/api\/sessions\/([^/]+)\/(events|messages|interrupt|goal|todos|ship|cache|rewind-points|rewind|fork)$/)
    if (m) {
      const [, sessionId, kind] = m
      // Accept any session that exists on disk (enables resume across restart),
      // not just ones created in this process.
      if (!Store.exists(sessionId)) return json({ error: "unknown session" }, 404)

      if (kind === "rewind-points" && req.method === "GET") {
        return json({ points: Store.rewindPoints(sessionId) })
      }

      if (kind === "fork" && req.method === "POST") {
        let body: ForkRequest
        try { body = await req.json() as ForkRequest } catch { return json({ error: "invalid JSON body" }, 400) }
        if (body.worktree != null && typeof body.worktree !== "boolean") return json({ error: "invalid worktree" }, 400)
        if (body.directive != null && typeof body.directive !== "string") return json({ error: "invalid directive" }, 400)
        if (sessionIsBusy(sessionId)) return json({ error: "session or child thread is running" }, 409)
        const workspace = Store.workspaceOf(sessionId) ?? LAUNCH_WORKSPACE
        const childId = randomUUID()
        const snapshot = snapshotWorkspace(workspace, `refs/sessions/${sessionId}`)
        if (!snapshot) return json({ error: "could not snapshot workspace" }, 409)
        let childWorkspace = workspace
        let worktree: { path: string; branch: string } | undefined
        let commonDir = ""
        if (body.worktree) {
          const created = createForkWorktree(workspace, childId, (target) => restoreSnapshot(workspace, snapshot, target))
          if (!created) return json({ error: "could not create or restore worktree" }, 409)
          childWorkspace = created.path; worktree = { path: created.path, branch: created.branch }; commonDir = created.gitCommonDir
        }
        try {
          Store.forkSession(childId, sessionId, childWorkspace, body.worktree ? "worktree" : "normal", body.directive, worktree ? { gitCommonDir: commonDir, branch: worktree.branch } : undefined)
          const latest = Store.rewindPoints(sessionId).find((p) => p.complete)
          if (latest) {
            const point = Store.turn(sessionId, latest.turn)
            if (point?.anchorCheckpointId) cloneThreadAtCheckpoint(sessionId, childId, point.anchorCheckpointId)
          }
        } catch (err) {
          if (worktree) removeForkWorktree(workspace, childWorkspace, worktree.branch)
          return json({ error: "could not persist fork" }, 409)
        }
        subscribers(childId)
        if (body.directive?.trim()) {
          const turn = beginUserTurn(childId, body.directive)
          emitTo(childId, { type: "message.user", text: body.directive })
          AsyncLocalStorageProviderSingleton.getInstance().run(undefined, () => dispatchRun(childId, body.directive!, undefined, undefined, turn))
        }
        const response: ForkResponse = { sessionId: childId, workspace: childWorkspace, parentSessionId: sessionId, ...(worktree ? { worktree } : {}) }
        return json(response)
      }

      if (kind === "rewind" && req.method === "POST") {
        let body: RewindRequest
        try { body = await req.json() as RewindRequest } catch { return json({ error: "invalid JSON body" }, 400) }
        if (!Number.isInteger(body.turn) || body.turn < 1) return json({ error: "invalid turn" }, 400)
        // The root registry covers root runs. Child/sidekick activity is visible
        // in the persisted lifecycle markers, including child threads spawned by
        // the current root run.
        if (sessionIsBusy(sessionId)) {
          return json({ error: "session or child thread is running" }, 409)
        }
        const point = Store.turn(sessionId, body.turn)
        if (!point) return json({ error: "unknown turn" }, 409)
        if (!point.snapshotCommit || !point.anchorCheckpointId) return json({ error: "turn is incomplete or cannot be rewound" }, 409)
        const workspace = Store.workspaceOf(sessionId) ?? LAUNCH_WORKSPACE
        // Best effort only: a safety ref improves recovery, but must not make an
        // otherwise valid rewind impossible.
        snapshotWorkspace(workspace, `refs/sessions/${sessionId}-pre-rewind`)
        if (!restoreSnapshot(workspace, point.snapshotCommit)) return json({ error: "could not restore workspace snapshot" }, 409)
        Store.rewindTranscript(sessionId, body.turn, point.startEventSeq)
        rewindCheckpoints(sessionId, point.anchorCheckpointId)
        Store.clearGoal(sessionId)
        Store.clearTodos(sessionId)
        emitTo(sessionId, { type: "session.rewound", sessionId, turn: body.turn })
        return json({ sessionId, turn: body.turn })
      }

      // GET .../events -> SSE. Replays persisted history first (== resume), then live.
      if (kind === "events" && req.method === "GET") {
        const history = Store.history(sessionId)
        reconcileStaleRun(sessionId, history)
        let selfController: Subscriber
        let heartbeat: ReturnType<typeof setInterval> | undefined
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            selfController = controller
            for (const ev of history) {
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
            ...corsHeaders(req),
          },
        })
      }

      // GET .../cache -> CacheStatusResponse. Read-only preflight: would a send
      // right now rebuild a cold cache? Lets the TUI warn BEFORE the user sends.
      if (kind === "cache" && req.method === "GET") {
        const model = effectiveSessionSelection(sessionId).model
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
        let steer = false
        let delivery: "auto" | "queue" | "interject" | "steer" = "auto"
        let skill: string | undefined
        let images: { base64: string; mediaType: string }[] | undefined
        try {
          const body = (await req.json()) as { text?: unknown; images?: unknown; force?: unknown; steer?: unknown; skill?: unknown; delivery?: unknown }
          text = typeof body?.text === "string" ? body.text : ""
          force = body?.force === true
          steer = body?.steer === true
          if (body?.delivery === "queue" || body?.delivery === "interject" || body?.delivery === "steer") delivery = body.delivery
          if (steer) delivery = "steer"
          skill = typeof body?.skill === "string" ? body.skill.trim() : undefined
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
        const visibleText = text
        if (skill) {
          const loaded = loadSkill(Store.workspaceOf(sessionId) ?? process.cwd(), skill, sessionId, true)
          if ("error" in loaded) return json({ error: `skill selection failed: ${loaded.error}` }, 400)
          text = `<skill-context name="${loaded.name}">\n${loaded.body}\n</skill-context>\n\n${text}`
        }

        // Steer: the client held this message until a tool boundary and now wants
        // to cut into the in-flight turn. Abort the current run and WAIT for it to
        // tear down before emitting/starting below, so events stay ordered. The
        // agent is checkpointed per-node, so the completed tool result survives
        // into the superseding turn. Cache is warm mid-turn → skip the cold guard.
        if (delivery === "interject" && running.has(sessionId)) {
          const buffer = interjections.get(sessionId) ?? new InterjectionBuffer()
          buffer.push({ id: randomUUID(), text: visibleText, images })
          interjections.set(sessionId, buffer)
          emitTo(sessionId, { type: "message.interjection", sessionId, text: visibleText, injected: false })
          return new Response(null, { status: 202, headers: corsHeaders(req) })
        }
        if (delivery === "steer") await abortForSteer(sessionId)

        // Cache guard: BEFORE running (or billing) anything, refuse a send that
        // would rebuild a big cold cache. 409 carries the details; the client
        // asks the user and re-POSTs with force: true (or starts a fresh thread).
        if (!force && delivery !== "steer") {
          const model = effectiveSessionSelection(sessionId).model
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

        if (visibleText) Store.setTitleIfDefault(sessionId, visibleText) // first message becomes the resume label

        // Echo the user turn into the event stream so it is persisted and
        // replayed on resume (clients render it instead of an optimistic local
        // echo). Emitted before the run so it lands ahead of the assistant reply.
        if (running.has(sessionId) || queueBusy.has(sessionId)) {
          const queue = promptQueues.get(sessionId) ?? new PromptQueue()
          try { queue.enqueue({ prompt: text, shown: visibleText, images, kind: "prompt" }) }
          catch { return json({ error: "prompt queue is full" }, 429) }
          promptQueues.set(sessionId, queue)
          emitTo(sessionId, { type: "queue.changed", sessionId, entries: queue.snapshot(), running: running.has(sessionId) })
          return new Response(null, { status: 202, headers: corsHeaders(req) })
        }

        const turn = visibleText ? beginUserTurn(sessionId, visibleText) : undefined
        if (visibleText) emitTo(sessionId, { type: "message.user", text: visibleText })

        // Abort any prior in-flight turn, then run this one (tracked so /interrupt
        // can cancel it). If a goal is active, runAgent keeps continuing it after.
        // A force-confirmed send skips the redundant turn-start cache notice.
        dispatchRun(sessionId, text, images, { suppressCacheWarning: force }, turn)

        return new Response(null, { status: 202, headers: corsHeaders(req) })
      }

      // POST .../interrupt -> abort the session's in-flight turn (Esc).
      if (kind === "interrupt" && req.method === "POST") {
        const ac = running.get(sessionId)
        if (ac) ac.abort()
        else reconcileStaleRun(sessionId)
        interjections.get(sessionId)?.clear()
        return new Response(null, { status: 202, headers: corsHeaders(req) })
      }

      // POST .../ship -> 202. Inject the handoff prompt into THIS session: its
      // model distills a brief from the conversation and calls ship_goal, which
      // creates + starts the fresh workflows-mode goal session. The prompt is
      // hidden (like a goal kickoff) — the user sees the brief being written.
      if (kind === "ship" && req.method === "POST") {
        let notes: string | undefined
        try {
          const body = (await req.json().catch(() => ({}))) as ShipRequest
          if (typeof body?.notes === "string" && body.notes.trim()) notes = body.notes
        } catch {
          // no/invalid body -> no notes
        }
        dispatchRun(sessionId, shipHandoffPrompt(notes))
        return new Response(null, { status: 202, headers: corsHeaders(req) })
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
            const mode = body.mode === "workflows" ? "workflows" : "direct"
            const goal: Goal = {
              sessionId,
              objective: body.objective.trim(),
              status: "active",
              mode,
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
              message: `◎ Goal set${mode === "workflows" ? " (orchestrator)" : ""} — ${firstLine(goal.objective)}`,
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
      if (kind === "todos" && req.method === "GET") return json(Store.getTodos(sessionId))
    }

    return new Response("not found", { status: 404, headers: corsHeaders(req) })
  },
})

const discoveryRecord = process.env.CHUNKY_DISCOVERY_RECORD
const ownershipId = process.env.CHUNKY_SERVER_ID
const cleanupDiscovery = () => {
  if (discoveryRecord && ownershipId) removeDiscoveryRecordIfOwned(discoveryRecord, ownershipId)
}
const stopOwnershipPoller = discoveryRecord && ownershipId
  ? startOwnershipPoller(discoveryRecord, ownershipId, () => {
      // A successor took the registration. Abort active work before stopping
      // the listener, matching the normal SIGTERM shutdown path.
      for (const controller of running.values()) controller.abort()
      cleanupDiscovery()
      server.stop(true)
      process.exitCode = 0
    })
  : undefined
const shutdown = () => {
  stopOwnershipPoller?.()
  cleanupDiscovery()
  for (const controller of running.values()) controller.abort()
  server.stop(true)
}
process.once("SIGTERM", shutdown)
process.once("SIGINT", shutdown)

console.log(
  `[@chunky/server] listening on http://localhost:${server.port} (provider=${activeProviderId()})`,
)

if (serverLeases) {
  const retirement = setInterval(() => {
    if (hasLiveSubscribers() || running.size > 0 || shuttingDown || !serverLeases.shouldRetire()) return
    const recordPath = process.env.CHUNKY_DISCOVERY_RECORD
    const nonce = process.env.CHUNKY_SERVER_NONCE
    if (recordPath && nonce) removeDiscoveryRecordIfOwned(recordPath, nonce)
    clearInterval(retirement)
    void shutdownServer("SIGTERM")
  }, 5_000)
  retirement.unref()
}

// Relay uplink: when this computer has been paired (`bun run pair` wrote
// relay.json), dial out to the relay so paired phones can reach this server —
// E2E-encrypted, the relay only ever sees ciphertext. CHUNKY_RELAY=0 skips
// the uplink for a boot without unpairing.
if (process.env.CHUNKY_RELAY !== "0") {
  const relayConfig = loadRelayConfig()
  if (relayConfig) {
    startUplink({
      config: relayConfig,
      localBaseUrl: `http://127.0.0.1:${server.port}`,
      log: (s) => console.log(`[relay] ${s}`),
    })
  }
}
