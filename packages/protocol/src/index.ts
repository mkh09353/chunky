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
  /** Provider-reported hidden reasoning/thinking tokens, when available. */
  reasoningTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  /** Model id that produced this usage, when known. */
  model?: string
}

export type MessageEndReason = "complete" | "max_tokens" | "interrupted" | "error"

export type MessageDelivery = "auto" | "queue" | "interject" | "steer"
export interface QueueEntry {
  id: string; version: number; text: string; shown: string
  kind: "prompt" | "steer" | "interject"; position: number; createdAt: number
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
  /** A user turn, echoed by the server so it is persisted and replayed on
   * resume. Clients render it as the user's own message (single source of
   * truth — no optimistic local echo needed). `from` is set when the message
   * was injected by ANOTHER session via send_to_session (a short human label,
   * e.g. `fix tests (0f3a21c9)`) — clients render provenance instead of a
   * plain user bubble. */
  | { type: "message.user"; text: string; threadId?: string; from?: string }
  | { type: "message.interjection"; sessionId: string; text: string; injected: boolean }
  | { type: "queue.changed"; sessionId: string; entries: QueueEntry[]; running: boolean }
  | { type: "message.start"; role: "assistant"; threadId?: string }
  | { type: "message.delta"; text: string; threadId?: string }
  | { type: "message.end"; reason?: MessageEndReason; detail?: string; threadId?: string }
  /** Extended-thinking / reasoning tokens streamed BEFORE the assistant answer.
   *  Providers that expose thinking (e.g. Claude) emit these; clients render them
   *  as a collapsible "thought" block. Absent for providers that don't. */
  | { type: "reasoning.start"; threadId?: string }
  | { type: "reasoning.delta"; text: string; threadId?: string }
  | { type: "reasoning.end"; threadId?: string }
  /** Provider usage for a completed model request. Persisted for diagnostics and
   *  future cost/context reporting; clients may ignore it. */
  | { type: "usage.update"; usage: UsageDelta; threadId?: string }
  | { type: "tool.start"; id: string; name: string; input: unknown; threadId?: string }
  | { type: "tool.end"; id: string; ok: boolean; output: string; raw?: unknown; threadId?: string }
  /** `model` is the child's EFFECTIVE model id (inherited or overridden) so the
   *  TUI can label each thread with the model running it — omitted if unknown. */
  | { type: "thread.spawn"; threadId: string; parentThreadId: string | null; title: string; model?: string }
  | { type: "thread.status"; threadId: string; status: "running" | "idle"; title?: string }
  /** Goal-mode lifecycle: emitted when a goal is set, auto-continues, completes,
   * blocks, or pauses. `goal` is the current snapshot (null once cleared) and
   * `message` is a short human line the TUI renders as a transcript marker. */
  | { type: "goal.update"; sessionId: string; goal: GoalSnapshot | null; message?: string }
  /** A dynamic-workflow phase boundary — groups the sub-agents that follow under
   *  `title` in the owning thread's transcript. `threadId` is the thread that ran
   *  the `workflow` tool (omitted for the main thread). The workflow's sub-agents
   *  themselves surface as ordinary child threads (thread.spawn/thread.status). */
  | { type: "workflow.phase"; runId: string; threadId?: string; title: string }
  /** A narrator line from a running workflow (start/finish, and each log() call),
   *  rendered in the owning thread's transcript. */
  | { type: "workflow.log"; runId: string; threadId?: string; message: string }
  | { type: "error"; message: string; threadId?: string }

/** Lifecycle of a session goal. `active` runs the continuation loop; `paused`
 *  stops it (turn budget hit, interrupted, or user-paused) but keeps the goal;
 *  `blocked`/`complete` are terminal for this objective. */
export type GoalStatus = "active" | "paused" | "blocked" | "complete"

/** How the goal-mode agent is asked to work. `direct` (the default): do the work
 *  hands-on. `workflows`: act as an ORCHESTRATOR — delegate all substantive work
 *  to dynamic-workflow runs (each sub-agent a real child thread, typically on a
 *  cheaper model), judge results between runs, and keep its own context lean. */
export type GoalMode = "direct" | "workflows"

/** The wire snapshot of a session's goal (a subset of the server's stored Goal). */
export interface GoalSnapshot {
  objective: string
  status: GoalStatus
  /** Omitted means "direct" (pre-mode servers). */
  mode?: GoalMode
  /** Auto-continuation turns spent so far this run. */
  turns: number
  /** Cap on auto-continuation turns before the goal pauses itself. */
  maxTurns: number
}

// ---- REST shapes ----
/** Body for POST ROUTES.createSession. The session is pinned to `repoId`'s
 *  workspace at creation; omitted -> the server's default repo. Every run on the
 *  session executes in that workspace, so sessions in different repos run
 *  concurrently on one server. */
export interface CreateSessionRequest {
  repoId?: string
}
export interface CreateSessionResponse {
  sessionId: string
}
export interface SendMessageRequest {
  text: string
  /** Send even if the cache guard would block (the user confirmed the re-send). */
  force?: boolean
  skill?: string
  images?: { base64: string; mediaType: string }[]
  /** Compatibility field; use delivery: "steer". */
  steer?: boolean
  delivery?: MessageDelivery
}

/** Why a thread's prompt cache is (or would be) cold, and how much a send now
 *  would re-send. Same fields the `cache.warning` event carries; used by the
 *  pre-send guard's 409 response and by GET cacheStatus. */
export interface CacheCold {
  reason: "idle" | "model-switch"
  idleMs?: number
  approxTokens: number
  fromModel?: string
  toModel?: string
}

/** 409 body from POST sendMessage when the cache guard blocks: the turn did NOT
 *  run and nothing was billed — re-POST with `force: true` once the user
 *  confirms, or start a fresh thread instead. */
export interface SendBlockedResponse {
  blocked: "cache-cold"
  warning: CacheCold
  /** The guard threshold (approx tokens) that tripped. */
  guardTokens: number
}

/** GET ROUTES.cacheStatus: would sending on this thread right now rebuild a
 *  cold cache? Lets clients warn BEFORE the user spends the tokens. */
export interface CacheStatusResponse {
  cold: CacheCold | null
  /** Current guard threshold in tokens; null = guard off. */
  guardTokens: number | null
}

/** GET/POST ROUTES.cacheGuard — the confirm-before-resend threshold. A send
 *  that would re-send at least `tokens` on a cold cache is refused (409) until
 *  confirmed with `force`. null disables the guard. */
export interface CacheGuardResponse {
  tokens: number | null
}
export interface SetCacheGuardRequest {
  tokens: number | null
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

/** A local folder Chunky can operate in. Threads are scoped per repo. */
export interface Repo {
  id: string
  path: string
  name: string
  addedAt: number
}
/** `activeId` is the server's DEFAULT repo — used only when a session is
 *  created without an explicit repoId. It is not execution state: which repo a
 *  client is looking at is the client's own UI state. */
export interface ReposResponse {
  repos: Repo[]
  activeId: string | null
}
export interface RepositoryInstructionsResponse {
  enabled: boolean
}
export interface AddRepoRequest {
  path: string
}

// ---- Managed skill repositories -------------------------------------------
export interface ManagedSkill {
  name: string
  description: string
  enabled: boolean
}
export interface SkillRepoStatus {
  id: string
  url: string
  branch?: string
  subdir?: string
  disabledSkills?: string[]
  addedAt: number
  lastSync?: number
  lastError?: string
  path: string
  present: boolean
  skills: ManagedSkill[]
}
export type SkillRepoAction = "add" | "remove" | "update" | "list" | "enable" | "disable"
export interface ManageSkillReposRequest {
  action: SkillRepoAction
  url?: string
  id?: string
  branch?: string
  subdir?: string
  skill?: string
}
export interface SkillReposResponse { action: SkillRepoAction; repos?: SkillRepoStatus[]; repo?: SkillRepoStatus; id?: string; updated?: number; failed?: number }
export interface SkillCatalogEntry {
  name: string
  description: string
  source: "user" | "project" | "repo"
  sourceLabel: string
  path: string
  enabled: boolean
}
export interface SkillsCatalogResponse { skills: SkillCatalogEntry[] }

// ---- Modes (named executor + advisor pairings) ----

/** The advisor half of a mode. */
export interface ModeAdvisor {
  provider: string
  model: string
  effort?: string
}
/** A named trio of executor + sidekick + advisor models, applied as one unit via
 *  /mode. Captures which combinations actually work well (e.g. a Fable executor
 *  with a Luna sidekick and a Sol advisor) so switching is one command, not
 *  three pickers. */
export interface ModeSpec {
  provider: string
  model: string
  effort?: string
  speed?: string
  /** The paired advisor; null = advisor explicitly off in this mode. */
  advisor?: ModeAdvisor | null
  /** The paired sidekick seat; null = seat unset in this mode (inherit);
   *  absent (undefined) = mode predates sidekicks, leave the seat alone. */
  sidekick?: ModeAdvisor | null
  /** Named sidekick seats (e.g. frontend/backend); null = clear all named
   *  seats in this mode; absent = mode predates seats, leave them alone. */
  sidekickSeats?: Record<string, ModeAdvisor> | null
}
export interface ModeInfo extends ModeSpec {
  name: string
}
/** GET ROUTES.modes: saved modes + the CURRENT (possibly unsaved) pairing. */
export interface ModesResponse {
  modes: ModeInfo[]
  current: ModeSpec
}
/** POST ROUTES.modes — save a mode. Omitted `spec` snapshots the current
 *  executor+advisor pairing under `name`. */
export interface SaveModeRequest {
  name: string
  spec?: ModeSpec
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
  updateStatus: `/api/update`,
  onboarding: `/api/onboarding`,
  onboardingComplete: `/api/onboarding/complete`,
  onboardingApply: `/api/onboarding/apply`,
  customProvider: `/api/providers/custom`,
  // POST CreateSessionRequest -> CreateSessionResponse (pinned to repoId's
  // workspace; the default repo when omitted).
  createSession: `/api/sessions`,
  listSessions: `/api/sessions`, // GET ?repo=<id> -> ListSessionsResponse (that repo's threads)
  // GET  -> ReposResponse. POST AddRepoRequest -> ReposResponse (add a folder;
  // it also becomes the default repo).
  repos: `/api/repos`,
  // POST -> ReposResponse. Persist a repo as the default for repo-less session
  // creation. Preference only — never retargets in-flight runs.
  selectRepo: (id: string) => `/api/repos/${id}/select`,
  // DELETE -> ReposResponse. Remove a repo from the list (does not delete files).
  removeRepo: (id: string) => `/api/repos/${id}`,
  // GET -> repository-scoped AGENTS.md setting; POST {enabled} updates it.
  repositoryInstructions: (id: string) => `/api/repos/${id}/instructions`,
  // POST SendMessageRequest -> 202, or 409 SendBlockedResponse when the cache
  // guard blocks (resend with force: true after the user confirms).
  sendMessage: (id: string) => `/api/sessions/${id}/messages`,
  // GET -> CacheStatusResponse. Would a send right now re-send a cold cache?
  cacheStatus: (id: string) => `/api/sessions/${id}/cache`,
  // GET -> CacheGuardResponse. POST SetCacheGuardRequest -> CacheGuardResponse.
  cacheGuard: `/api/cache-guard`,
  // POST -> 202. Abort the session's in-flight turn (user interrupt / Esc).
  interrupt: (id: string) => `/api/sessions/${id}/interrupt`,
  // GET -> SSE stream of AgentEvent. Replays persisted history first, so opening
  // this on an existing id IS "resume": the full prior transcript streams, then live.
  events: (id: string) => `/api/sessions/${id}/events`,
  // GET ?q=&limit=&repo=<id> -> { items: FileSearchItem[] } — FFF fuzzy search
  // for @-mentions, scoped to one repo (default repo when omitted).
  fileSearch: `/api/files/search`,
  // GET  -> GoalStateResponse (current goal, or null).
  // POST GoalRequest -> GoalStateResponse. Set an objective (starts the loop) or
  // run a lifecycle action (pause/resume/clear).
  goal: (id: string) => `/api/sessions/${id}/goal`,
  // POST ShipRequest -> 202. Ask THIS session to write a handoff brief and ship
  // it to a fresh workflows-mode goal session (via the ship_goal tool).
  ship: (id: string) => `/api/sessions/${id}/ship`,
  // GET -> ModesResponse. POST SaveModeRequest -> ModesResponse (save/snapshot).
  modes: `/api/modes`,
  // POST -> the applied selection + advisor (also invalidates the agent cache).
  applyMode: (name: string) => `/api/modes/${encodeURIComponent(name)}/apply`,
  // DELETE -> ModesResponse.
  deleteMode: (name: string) => `/api/modes/${encodeURIComponent(name)}`,
  // GET list; POST ManageSkillReposRequest. Skill state is persisted per repo.
  skillRepos: `/api/skill-repos`,
} as const

/** Body for POST ROUTES.goal. Exactly one of `objective` (set + start the goal)
 *  or `action` (manage an existing goal) is expected. */
export interface GoalRequest {
  /** Set this objective and start working toward it. */
  objective?: string
  /** Optional cap on auto-continuation turns (defaults server-side). */
  maxTurns?: number
  /** How the goal agent works: hands-on (`direct`, default) or as a
   *  workflow-orchestrator (`workflows`). Only meaningful with `objective`. */
  mode?: GoalMode
  /** Lifecycle action on the current goal. */
  action?: "pause" | "resume" | "clear"
}

/** Body for POST ROUTES.ship — hand the current session's plan off to a fresh
 *  goal-orchestrator session. The server injects a hidden prompt telling this
 *  session's model to distill a handoff brief and call the `ship_goal` tool,
 *  which creates the new session and starts its workflows-mode goal. 202 on
 *  dispatch; progress streams over the session's SSE like any turn. */
export interface ShipRequest {
  /** Extra user guidance folded into the handoff brief (e.g. scope notes). */
  notes?: string
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
  try {
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
  } finally {
    reader.releaseLock()
  }
}
