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

export interface UsageSeriesBucket {
  date: string
  requests: number
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  estimatedApiCost: number
  unpricedRequests: number
  byProvider: { provider: string; billing: string | null; estimatedApiCost: number; tokens: number }[]
}
export interface UsageSeriesResponse { from: string; to: string; bucket: "day"; buckets: UsageSeriesBucket[] }
export interface UsageModelRow {
  provider: string; model: string; billing: string | null
  requests: number
  inputTokens: number; outputTokens: number; reasoningTokens: number
  cacheReadTokens: number; cacheWriteTokens: number
  estimatedApiCost: number; priced: boolean
  avgRating: number | null; ratedCount: number; reworkRate: number | null
  /** Rating split by delegation kind + seat. Optional so older clients ignore it.
   *  `seat` is null for the default/unnamed seat (`NULL` / `'default'`). */
  scoreBySeat?: Array<{
    kind: string
    seat: string | null
    avgRating: number | null
    ratedCount: number
    reworkRate: number | null
    samples: number
  }>
}
export interface UsageBreakdownResponse {
  rows: UsageModelRow[]
  totals: { estimatedApiCost: number; totalTokens: number; pricedShare: number; cacheSavings: number }
  providers: { provider: string; billing: string | null; estimatedApiCost: number; tokens: number; share: number }[]
}
export interface SessionCacheMetrics {
  turns: number
  inputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  promptTokens: number
  cacheHitRate: number | null
  coldTurns: number
  unclassifiedTurns: number
  detachedWakeTurns: number
  coldDetachedWakeTurns: number
  coldDetachedWakeInputTokens: number
  coldDetachedWakeCacheWriteTokens: number
}
export type ResourcePercentiles = { p50: number; p95: number; p99: number; max: number }
export interface ResourceUsageResponse {
  status: "ok"
  sampleCount: number
  intervalMs: number
  windowMs: number
  server: {
    rssBytes: ResourcePercentiles
    cpuPercent: ResourcePercentiles
    current: { rssBytes: number; heapUsedBytes: number; cpuPercent: number }
  }
  children: { rssBytes: ResourcePercentiles; cpuPercent: ResourcePercentiles }
  total: { rssBytes: ResourcePercentiles; cpuPercent: ResourcePercentiles }
  peaks: Array<{
    ts: number
    totalRssBytes: number
    serverRssBytes: number
    cpuPercent: number
    activeSessions: number | null
    liveTasks: number | null
    liveDelegates: number | null
    topTasks: Array<{ taskId: string; sessionId: string; command: string; rssBytes: number }>
  }>
}

export type ProviderQuotaStatus = "available" | "stale" | "not-authenticated" | "unsupported" | "error"
export type ProviderQuotaWindowKind = "five-hour" | "weekly" | "weekly-model" | "other"
export interface ProviderQuotaWindow {
  kind: ProviderQuotaWindowKind
  label: string
  usedPercent: number | null
  resetAt: number | null
  windowMinutes?: number
  model?: string
}
export interface ProviderQuota {
  provider: string
  billing: "subscription" | "api-key" | null
  status: ProviderQuotaStatus
  source: "codex-usage" | "response-headers" | "anthropic-sdk" | null
  fetchedAt: number | null
  windows: ProviderQuotaWindow[]
  error?: string
}
export interface ProviderQuotasResponse { fetchedAt: number; providers: ProviderQuota[] }

export type MessageEndReason = "complete" | "max_tokens" | "interrupted" | "error"

export type MessageDelivery = "auto" | "queue" | "interject" | "steer"
export interface QueueEntry {
  id: string; version: number; text: string; shown: string
  kind: "prompt" | "steer" | "interject"; position: number; createdAt: number
}
export interface ListeningPort {
  port: number        // listening TCP port
  address: string     // bind address as reported (e.g. "127.0.0.1", "*", "::")
  pid: number         // owning process pid
  command: string     // short process name (e.g. "ruby", "node")
  taskId: string      // owning background task/monitor id
  url: string | null  // server-suggested URL ("http://localhost:<port>/") when plausibly reachable, else null
}
export interface PromoteQueueRequest { delivery: "steer" | "interject" }
export interface PromoteQueueResult { outcome: "promoted" | "already-running" | "not-found" }

export type AgentEvent =
  | { type: "session.status"; sessionId: string; status: "idle" | "running" }
  | { type: "session.title"; sessionId: string; title: string }
  /** Sent only to currently attached clients after a rewind. It is deliberately
   * not part of transcript history: clients must reconnect and replay. */
  | { type: "session.rewound"; sessionId: string; turn: number }
  /** Live task counts; deliberately not persisted in transcript history. */
  | { type: "background.changed"; sessionId: string; tasks: number; monitors: number }
  /** Authoritative live listening-port snapshot; deliberately not persisted in transcript history. */
  | { type: "ports.changed"; sessionId: string; ports: ListeningPort[] }
  /** Ask only currently attached app clients for this session to open a URL in
   * their browser pane. LIVE-ONLY: never persisted or replayed. */
  | { type: "app.open_url"; url: string }
  /** Ask only currently attached desktop clients for this session to collect an
   * API key. LIVE-ONLY: the request and secret are never persisted or replayed. */
  | { type: "app.request_api_key"; requestId: string; providerId: string; label: string }
  /** A saved mode changed executor/agent configuration. With `sessionId` this
   * is live-only for that session; without it the server-wide defaults changed. */
  | { type: "mode.applied"; name: string; spec: ModeSpec; sessionId?: string }
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
  /** Older model context was replaced by a summary. The durable event transcript
   * remains intact and can be queried with the recall tool. */
  | { type: "context.compacted"; sessionId: string }
  /** Live-only notification when compaction could not produce a safe summary. */
  | { type: "context.compaction_failed"; sessionId: string; reason?: string }
  /** A user turn, echoed by the server so it is persisted and replayed on
   * resume. Live clients may render an optimistic local echo and suppress this
   * same-session event to avoid a duplicate. `from` is set when the message
   * was injected by ANOTHER session via send_to_session (a short human label,
   * e.g. `fix tests (0f3a21c9)`) — clients render provenance instead of a
   * plain user bubble. */
  | { type: "message.user"; text: string; threadId?: string; from?: string; imageCount?: number }
  | { type: "message.interjection"; sessionId: string; text: string; injected: boolean; imageCount?: number }
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
  | { type: "tool.progress"; id: string; chunk: string; threadId?: string }
  | { type: "tool.end"; id: string; ok: boolean; output: string; raw?: unknown; threadId?: string }
  /** `model` is the child's EFFECTIVE model id (inherited or overridden) so the
   *  TUI can label each thread with the model running it — omitted if unknown. */
  | { type: "thread.spawn"; threadId: string; parentThreadId: string | null; title: string; model?: string }
  | { type: "thread.status"; threadId: string; status: "running" | "idle" | "cancelled"; title?: string }
  /** Goal-mode lifecycle: emitted when a goal is set, auto-continues, completes,
   * blocks, or pauses. `goal` is the current snapshot (null once cleared) and
   * `message` is a short human line the TUI renders as a transcript marker. */
  | { type: "goal.update"; sessionId: string; goal: GoalSnapshot | null; message?: string }
  | { type: "todos.update"; sessionId: string; todos: TodoSnapshot[] }
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

export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled"
export interface TodoSnapshot { id: string; content: string; status: TodoStatus; assignee?: string; activeForm?: string }

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
  cwd?: string
  /** Omit for legacy default-repository creation. `none` creates a session
   * with no repository or working directory. */
  repositoryScope?: "default" | "none"
}
export interface CreateSessionResponse {
  sessionId: string
}
export interface ServerInfoResponse { workspace: string; version?: string; buildId?: string; channel?: "managed" | "dev" }
/** POST CompactRequest -> { ok: boolean } */
export interface CompactRequest { hint?: string }

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

/** GET/POST ROUTES.evals — sidekick eval recorder. Default mode is "record". */
export type EvalsMode = "off" | "record"
export type EvalPromoteBucket = "hard" | "regression" | "random"
export interface EvalsStats {
  candidates: number
  promoted: number
  /** Total size on disk of state/evals. */
  bytes: number
}
export interface EvalsResponse {
  mode: EvalsMode
  stats: EvalsStats
}
export interface SetEvalsRequest {
  mode: EvalsMode
}
export interface EvalBriefStruct {
  task: string
  constraints?: string[]
  done_when?: string
  pointers?: string
  seat?: string
}
export interface EvalCandidateJson {
  delegationId: string
  sessionId: string
  seat?: string
  sidekickThreadId: string
  provider: string
  model: string
  effort?: string
  workspace: string
  briefStruct?: EvalBriefStruct
  briefComposed: string
  snapshotRef: string
  snapshot: string | null
  startedAt: number
  startSeq: number
}
export interface EvalReportJson {
  ok: boolean
  finalReport: string
  completedAt: number
  endSeq: number
}
export interface EvalRatingJson {
  compliance: number
  correctness: number
  report: number
  exceeded: number
  rework: boolean
  diagnosis?: string
  reason: string
  rating: number
  judgeProvider: string
  judgeModel: string
  ts: number
}
export interface EvalCandidateSummary {
  delegationId: string
  sessionId: string
  seat?: string
  provider: string
  model: string
  /** briefStruct.task when present, otherwise the first 200 chars of briefComposed. */
  task: string
  startedAt: number
  ok?: boolean
  rating?: number
  rework?: boolean
  diagnosis?: string
  promoted: boolean
  promotedBucket?: EvalPromoteBucket
  promotedAt?: number
}
export interface EvalCandidatesResponse {
  candidates: EvalCandidateSummary[]
}
export interface EvalCandidateDetailResponse {
  candidate: EvalCandidateJson
  report?: EvalReportJson
  rating?: EvalRatingJson
  promoted: boolean
  promotedBucket?: EvalPromoteBucket
  promotedAt?: number
}
export interface PromoteEvalCandidateRequest {
  bucket?: EvalPromoteBucket
}
export interface EvalReplayRequest {
  provider?: string
  model?: string
  effort?: string
}
export interface EvalReplayStartResponse {
  replayId: string
  status: "running"
}
export type EvalReplayStatus = "running" | "done" | "error"
export interface EvalReplaySummary {
  replayId: string
  provider: string
  model: string
  effort?: string
  status: EvalReplayStatus
  ok?: boolean
  startedAt: number
  completedAt?: number
}
export interface EvalReplaysResponse {
  replays: EvalReplaySummary[]
}
export interface EvalReplayResultJson {
  replayId: string
  provider: string
  model: string
  effort?: string
  ok: boolean
  finalReport: string
  startedAt: number
  completedAt: number
  diff: string
}
/** One row in the resume picker: a persisted session the client can reattach to. */
export interface SessionSummary {
  sessionId: string
  title: string
  createdAt: number
  lastActivity: number
  workspace: string | null
  /** Explicit repository-less scope; omitted by older servers. */
  repositoryScope?: "repository" | "none"
  /** True while at least one live SSE client is attached to this session. */
  attached?: boolean
  /** True while the session's root run is currently executing. */
  running?: boolean
  /** True while the root run or any delegate thread (child, sidekick, detached
   * spawn, or workflow agent) is still running; excludes background tasks/monitors. */
  busy?: boolean
  incognito?: boolean
  /** Registry id of the repository this session's workspace belongs to — its
   *  MAIN worktree, so a session running in a linked worktree still reports the
   *  repo it came from. Absent when the server cannot resolve it (no git, path
   *  gone, older server): clients must then render a flat, ungrouped list. */
  repoId?: string
  /** Git branch checked out in the session's workspace. Absent on detached
   *  HEAD, outside a repository, or when resolution failed. */
  branch?: string
  /** Set ONLY when `workspace` is a linked worktree rather than the repository's
   *  main one. Its absence means "main worktree (or unknown)", never "no repo". */
  worktree?: { path: string; isLinked: true }
  /** Server-archived cold session; only returned for `archived=1` requests
   *  (and the mobile shell list). Never present on a live row. */
  archived?: boolean
}
export interface ListSessionsResponse {
  sessions: SessionSummary[]
}
/** GET ROUTES.shellSessions — compact cross-repository resume list. */
export interface ShellSessionsResponse {
  sessions: SessionSummary[]
}
/** SSE event payload for ROUTES.sessionStream. */
export interface SessionDelta {
  upsert: SessionSummary[]
  remove: string[]
}
/** One pull request row in the PR reviews board. */
export interface PrSummary {
  /** GraphQL node id. */
  id: string
  number: number
  title: string
  url: string
  /** "org/name". */
  repo: string
  headRef: string
  author: string
  isDraft: boolean
  ciStatus: "passing" | "failing" | "pending" | "none"
  reviewDecision: "approved" | "changes_requested" | "review_required" | "none"
  unresolvedThreads: number
  labels: string[]
  createdAt: string
  updatedAt: string
  /** Session the server spun up to resolve comments / review this PR, if any. */
  linkedSessionId?: string
}
/** GET ROUTES.prReviews / POST ROUTES.prReviewsRefresh response. */
export interface PrReviewsState {
  org: string | null
  /** True when a GitHub token is available (settings or `gh auth token`). */
  configured: boolean
  /** My open PRs in the org. */
  mine: PrSummary[]
  /** Others' open PRs labeled ready-to-review, oldest first. */
  reviewQueue: PrSummary[]
  fetchedAt: number | null
  error?: string
}
/** GET ROUTES.prReviewsConfig response. Token is write-only; never echoed. */
export interface PrReviewsConfig {
  org?: string
  /** Orgs the authenticated user belongs to (best effort). */
  orgs?: string[]
  hasToken: boolean
  /** Label that marks a PR ready for review (default "ready-to-review"). */
  readyLabel?: string
}
/** POST ROUTES.prReviewsConfig body. Omitted fields are left unchanged. */
export interface UpdatePrReviewsConfigRequest {
  org?: string
  token?: string
  readyLabel?: string
}
/** POST ROUTES.prResolveComments / ROUTES.prStartReview body. */
export interface PrActionRequest {
  /** "org/name". */
  repo: string
  number: number
}
/** Response: the goal session spun up for the action, bound to a local checkout. */
export interface PrActionResponse {
  sessionId: string
  repoId: string
}

export interface RewindPoint { turn: number; createdAt: number; userText: string; complete: boolean }
export interface RewindPointsResponse { points: RewindPoint[] }
export interface RewindRequest { turn: number }
export interface RewindResponse { sessionId: string; turn: number }

/** `/fork` — branch the session. `worktree` asks the server to cut a new git
 * worktree for the child; `directive` seeds the child's first instruction. */
export interface ForkRequest { worktree?: boolean; directive?: string }
export interface ForkResponse {
  sessionId: string
  workspace: string
  parentSessionId: string
  worktree?: { path: string; branch: string }
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
/** Model affinity for a skill: delegates loading this skill should run on
 * this model. "prefer" = advisory (semi lock); "require" = load_skill on a
 * mismatched model warns loudly and directs re-delegation. */
export interface SkillModelBinding {
  provider: string
  model: string
  effort?: string
  lock: "prefer" | "require"
}
export interface ManagedSkill {
  name: string
  description: string
  enabled: boolean
  binding?: SkillModelBinding
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
export type SkillRepoAction = "add" | "remove" | "update" | "list" | "enable" | "disable" | "bind" | "unbind"
export interface ManageSkillReposRequest {
  action: SkillRepoAction
  url?: string
  id?: string
  branch?: string
  subdir?: string
  skill?: string
  /** For action "bind": the model binding to persist for `skill`. */
  binding?: SkillModelBinding
}
export interface SkillReposResponse { action: SkillRepoAction; repos?: SkillRepoStatus[]; repo?: SkillRepoStatus; id?: string; updated?: number; failed?: number }
export interface SkillCatalogEntry {
  name: string
  description: string
  source: "user" | "project" | "repo"
  sourceLabel: string
  path: string
  enabled: boolean
  binding?: SkillModelBinding
}
export interface SkillsCatalogResponse { skills: SkillCatalogEntry[] }

// ---- Modes (named executor + advisor pairings) ----

/** The advisor half of a mode. */
export interface SoloAdvisorConfig {
  enabled: boolean
  provider?: string
  model?: string
  effort?: string
}
export interface ModeAdvisor {
  provider: string
  model: string
  effort?: string
  /** Named sidekick seats may pin a speed (e.g. "fast"); advisor/sidekick ignore it. */
  speed?: string
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
  /** undefined inherits the global reviewer; null explicitly disables it. */
  review?: ModeAdvisor | null
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
  current: ModeSpec & { solo?: boolean }
}

/** One session's authoritative effective agent configuration. `source` says
 * whether it is isolated from later global-default changes. */
export interface SessionAgentConfigResponse {
  selection: {
    provider: string
    model?: string | null
    effort?: string | null
    speed?: string | null
    solo: boolean
  }
  source: "session-mode" | "session-selection" | "global"
  activeMode: string | null
  advisor: SoloAdvisorConfig
  review: SoloAdvisorConfig
  sidekick: SoloAdvisorConfig
  sidekickSeats: Record<string, ModeAdvisor>
}
/** One provider row in GET ROUTES.onboarding. `inherited` = credentials found
 *  outside Chunky (e.g. the Claude CLI login); it counts as ready. */
export interface OnboardingProviderStatus {
  id: string
  label: string
  status: "ready" | "inherited" | "missing"
  detail?: string
}
/** A mode the server suggests seeding/applying during onboarding. `locked`
 *  means at least one provider the spec references is not ready yet; the spec
 *  is still complete so the client can show exactly what it would apply. */
export interface OnboardingSuggestedMode {
  name: string
  description: string
  spec: ModeSpec
  locked?: boolean
  missingProviders?: string[]
}
/** The canonical recommended mode. `requires` lists the providers the client
 *  should drive the user through; `missing` is the subset not ready yet. */
export interface OnboardingRecommendation {
  name: "fire"
  requires: string[]
  missing: string[]
}
/** GET ROUTES.onboarding. */
export interface OnboardingResponse {
  providers: OnboardingProviderStatus[]
  onboardedAt: number | null
  suggestedModes: OnboardingSuggestedMode[]
  recommended: OnboardingRecommendation | null
}
/** POST ROUTES.onboardingApply — save `mode` under `name` (default "default"),
 *  pin it as the active mode, and apply it globally. 409 when any provider the
 *  spec references is not ready. */
export interface OnboardingApplyRequest {
  name?: string
  mode: ModeSpec
}
export interface OnboardingApplyResponse {
  applied: string
  spec: ModeSpec
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

/** Result of POST ROUTES.authTest: provider credential preflight. */
export interface AuthTestResult {
  ok: boolean
  error?: string
}

/** Result of POST ROUTES.authLogout after persisted provider credentials are removed. */
export interface AuthLogoutResult {
  ok: boolean
}

/** Body for POST ROUTES.providerKey. A missing/empty key cancels requestId. */
export interface ProviderKeyRequest {
  requestId?: string
  key?: string
}

/** Result of POST ROUTES.providerKey. The submitted key is never returned. */
export interface ProviderKeyResponse {
  ok: boolean
  error?: string
}

export type McpServerStatus = "unconfigured" | "needs-auth" | "connected"
export interface McpServerSummary { id: string; url?: string; enabled: boolean; status: McpServerStatus }
export interface McpServersResponse { servers: McpServerSummary[] }

// ---- Desktop relay pairing (local server API) ----
// Responses deliberately omit relay/account tokens, device private keys, pairing
// claims, and pairing secrets. `qrPayload` is the one ephemeral exception: the
// canonical chunky1 QR string necessarily contains its one-time pairing secret.
export interface RelayPeerStatus {
  deviceId: string
  name: string
}
export interface RelayStatusResponse {
  paired: boolean
  enabled: boolean
  relayUrl?: string
  peers?: RelayPeerStatus[]
}
export interface RelayBeginPairingResponse {
  /** Ephemeral canonical chunky1 pairing string; contains a one-time secret. */
  qrPayload: string
  relayUrl: string
  name: string
  expiresAt: number
}
export type RelayPollPairingResponse =
  | { status: "pending"; expiresAt: number }
  | { status: "claimed"; peer: RelayPeerStatus }
  | { status: "expired" }
  | { status: "error"; error: string }

// ---- Endpoints (relative to http://localhost:<port>) ----
export const ROUTES = {
  serverInfo: `/api/info`,
  updateStatus: `/api/update`,
  onboarding: `/api/onboarding`,
  onboardingComplete: `/api/onboarding/complete`,
  onboardingApply: `/api/onboarding/apply`,
  customProvider: `/api/providers/custom`,
  providerKey: (provider: string) => `/api/providers/${encodeURIComponent(provider)}/key`,
  usageSeries: `/api/usage/series`,
  usageBreakdown: `/api/usage/breakdown`,
  usageCache: `/api/usage/cache`,
  usageResources: `/api/usage/resources`,
  providerQuotas: `/api/provider-quotas`,
  // Local authenticated desktop pairing API. No unpair route: the hosted relay
  // protocol has no targeted revocation operation.
  relay: `/api/relay`,
  relayBegin: `/api/relay/begin`,
  relayPoll: `/api/relay/poll`,
  // POST -> AuthTestResult. Preflight provider credentials (OAuth refresh where needed).
  authTest: (provider: string) => `/api/auth/${encodeURIComponent(provider)}/test`,
  // POST -> AuthLogoutResult. Remove the provider’s persisted credentials.
  authLogout: (provider: string) => `/api/auth/${encodeURIComponent(provider)}/logout`,
  mcpServers: `/api/mcp/servers`,
  mcpAuthorize: (id: string) => `/api/mcp/${encodeURIComponent(id)}/authorize`,
  mcpStatus: (id: string) => `/api/mcp/${encodeURIComponent(id)}/status`,
  mcpLogout: (id: string) => `/api/mcp/${encodeURIComponent(id)}/logout`,
  // POST CreateSessionRequest -> CreateSessionResponse (pinned to repoId's
  // workspace; the default repo when omitted).
  createSession: `/api/sessions`,
  listSessions: `/api/sessions`, // GET ?repo=<id>&cwd=<path>&scope=none -> ListSessionsResponse (live only); ?archived=1 (+repo/cwd, not scope=none) -> cold sessions only, each `archived: true`
  shellSessions: `/api/sessions/shell`, // GET -> ShellSessionsResponse
  sessionStream: `/api/sessions/stream`, // GET SSE: snapshot + SessionDelta
  prReviews: `/api/pr-reviews`, // GET -> PrReviewsState (cached)
  prReviewsRefresh: `/api/pr-reviews/refresh`, // POST -> PrReviewsState (force poll)
  // GET -> PrReviewsConfig. POST UpdatePrReviewsConfigRequest -> PrReviewsConfig.
  prReviewsConfig: `/api/pr-reviews/config`,
  prResolveComments: `/api/pr-reviews/resolve`, // POST PrActionRequest -> PrActionResponse
  prStartReview: `/api/pr-reviews/review`, // POST PrActionRequest -> PrActionResponse
  renameSession: (id: string) => `/api/sessions/${id}`,
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
  // POST { sessionId? } -> run repository memory consolidation now.
  dream: `/api/dream`,
  /** GET/POST global asynchronous reviewer default. */
  review: `/api/review`,
  soloAdvisor: `/api/solo-advisor`,
  // POST SendMessageRequest -> 202, or 409 SendBlockedResponse when the cache
  // guard blocks (resend with force: true after the user confirms).
  sendMessage: (id: string) => `/api/sessions/${id}/messages`,
  // POST CompactRequest -> { ok: boolean }
  compactSession: (id: string) => `/api/sessions/${id}/compact`,
  queueEntry: (sessionId: string, entryId: string) => `/api/sessions/${sessionId}/queue/${entryId}`,
  promoteQueueEntry: (sessionId: string, entryId: string) => `/api/sessions/${sessionId}/queue/${entryId}/promote`,
  // GET -> CacheStatusResponse. Would a send right now re-send a cold cache?
  cacheStatus: (id: string) => `/api/sessions/${id}/cache`,
  // GET -> CacheGuardResponse. POST SetCacheGuardRequest -> CacheGuardResponse.
  cacheGuard: `/api/cache-guard`,
  // GET -> EvalsResponse. POST SetEvalsRequest -> EvalsResponse.
  evals: `/api/evals`,
  // GET -> EvalCandidatesResponse, newest-first.
  evalsCandidates: `/api/evals/candidates`,
  // GET -> EvalCandidateDetailResponse. DELETE prunes a non-promoted candidate.
  evalsCandidate: (id: string) => `/api/evals/candidates/${encodeURIComponent(id)}`,
  // GET -> gunzipped JSONL, text/plain.
  evalsCandidateTranscript: (id: string) => `/api/evals/candidates/${encodeURIComponent(id)}/transcript`,
  // POST PromoteEvalCandidateRequest -> EvalCandidateDetailResponse. 409 if already promoted.
  evalsCandidatePromote: (id: string) => `/api/evals/candidates/${encodeURIComponent(id)}/promote`,
  // POST EvalReplayRequest -> EvalReplayStartResponse. 409 if a replay is already running.
  evalsCandidateReplay: (id: string) => `/api/evals/candidates/${encodeURIComponent(id)}/replay`,
  // GET -> EvalReplaysResponse.
  evalsCandidateReplays: (id: string) => `/api/evals/candidates/${encodeURIComponent(id)}/replays`,
  // POST -> 202. Abort the session's in-flight turn (user interrupt / Esc).
  interrupt: (id: string) => `/api/sessions/${id}/interrupt`,
  // POST StopDelegateRequest -> StopDelegateResponse. Cancel a live sidekick
  // brief or detached spawn without aborting the lead turn.
  stopDelegate: (id: string) => `/api/sessions/${id}/stop-delegate`,
  // GET -> SSE stream of AgentEvent. Replays persisted history first, so opening
  // this on an existing id IS "resume": the full prior transcript streams, then live.
  events: (id: string) => `/api/sessions/${id}/events`,
  // GET ?turns=&before= -> bounded transcript tail / older turn page.
  sessionHistory: (id: string) => `/api/sessions/${id}/history`,
  rewindPoints: (id: string) => `/api/sessions/${id}/rewind-points`,
  rewind: (id: string) => `/api/sessions/${id}/rewind`,
  fork: (id: string) => `/api/sessions/${id}/fork`,
  // GET -> SessionAgentConfigResponse: authoritative effective model + delegates.
  agentConfig: (id: string) => `/api/sessions/${id}/agent-config`,
  // GET ?q=&limit=&repo=<id>&session=<id> -> { items: FileSearchItem[] } — FFF
  // fuzzy search for @-mentions. A session scopes to its pinned workspace;
  // repo/default scope remains for callers that omit it.
  fileSearch: `/api/files/search`,
  // GET  -> GoalStateResponse (current goal, or null).
  // POST GoalRequest -> GoalStateResponse. Set an objective (starts the loop) or
  // run a lifecycle action (pause/resume/clear).
  goal: (id: string) => `/api/sessions/${id}/goal`,
  // GET -> TodoSnapshot[] — the session's current todo checklist (read-only).
  todos: (id: string) => `/api/sessions/${id}/todos`,
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
  // GET -> AppBrowserResponse. POST AppBrowserAnnounce -> AppBrowserResponse.
  // The desktop app announces its built-in browser pane's CDP endpoint here on
  // startup so agent tooling can drive that pane. Held in memory only — the
  // endpoint dies with the app, and a persisted port would just be a lie after
  // a restart.
  appBrowser: `/api/app/browser`,
  // GET -> AppZooResponse. POST AppZooAnnounce -> AppZooResponse.
  appZoo: `/api/app/zoo`,
} as const

/** The desktop app's built-in browser pane, as a remotely drivable target.
 *
 *  The pane runs on CEF (Chromium) with a Chrome DevTools Protocol listener on
 *  loopback, so a tool can attach and navigate/evaluate against exactly what the
 *  user is looking at. */
export interface AppBrowserEndpoint {
  /** DevTools port on 127.0.0.1. */
  cdpPort: number
  /** Convenience base, e.g. `http://127.0.0.1:9223` — append /json/version. */
  cdpUrl: string
  /** Which renderer the pane actually got. Only "cef" is CDP-drivable. */
  renderer: "cef" | "native"
  /** False when the app fell back to the system WebView (pane still works, but
   *  there is no CDP listener — tools should say so rather than hang). */
  debuggable: boolean
  /** Epoch ms of the announcement, so a stale entry is recognisable. */
  announcedAt: number
}

/** Body for POST ROUTES.appBrowser. */
export interface AppBrowserAnnounce {
  cdpPort: number
  renderer: "cef" | "native"
  debuggable: boolean
}

/** GET/POST ROUTES.appBrowser: the last announced endpoint, or null when no
 *  desktop app has checked in since the server started. */
export interface AppBrowserResponse {
  browser: AppBrowserEndpoint | null
}

export interface AppZooAnnounce {
  port: number
  token: string
}

export interface AppZooResponse {
  connected: boolean
}

/** Body for POST ROUTES.stopDelegate. Target a detached run by id, or a live
 *  sidekick by seat. Omitting both (or omitting seat) means the default seat
 *  only when that is unambiguous. */
export interface StopDelegateRequest {
  runId?: string
  seat?: string
}
/** Result of POST ROUTES.stopDelegate / the stop_delegate tool. */
export type StopDelegateOutcome = "cancelled" | "already-finished" | "not-found" | "ambiguous"
export interface StopDelegateResponse {
  outcome: StopDelegateOutcome
  status?: "cancelled" | "completed" | "failed"
  runId?: string
  seat?: string
  threadId?: string
  message: string
}

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

// ---- Session event replay cursors ------------------------------------------

export interface SessionEventCursor { generation: string; nextSeq: number }

export interface SessionHistoryRequest {
  /** Root user turns to return. Defaults to 10 and is clamped to [1, 100]. */
  turns?: number
  /** Opaque exclusive cursor returned by the previous, newer page. */
  before?: string
}

export interface SessionHistoryResponse {
  events: Array<{ seq: number; event: AgentEvent }>
  /** V2 stream resume position captured before this page was read. */
  cursor: SessionEventCursor
  /** Cursor for the next older page, or null at the beginning of history. */
  before: string | null
  hasMore: boolean
  firstSeq: number | null
  lastSeq: number | null
}

export interface SessionHistoryPageCursor { generation: string; beforeSeq: number }

/** Opaque URL-safe cursor for a position in one session history generation. */
export function encodeSessionEventCursor(c: SessionEventCursor): string {
  const json = JSON.stringify({ v: 1, g: c.generation, n: c.nextSeq })
  const bytes = new TextEncoder().encode(json)
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

/** Decode a replay cursor, rejecting malformed or unsupported positions. */
export function decodeSessionEventCursor(s: string): SessionEventCursor | null {
  try {
    if (!s || !/^[A-Za-z0-9_-]+$/.test(s)) return null
    const base64 = s.replace(/-/g, "+").replace(/_/g, "/")
    const padded = base64 + "=".repeat((4 - base64.length % 4) % 4)
    const binary = atob(padded)
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
    const value = JSON.parse(new TextDecoder().decode(bytes)) as { v?: unknown; g?: unknown; n?: unknown }
    if (value.v !== 1 || typeof value.g !== "string" || !value.g) return null
    if (typeof value.n !== "number" || !Number.isInteger(value.n) || value.n < 0) return null
    return { generation: value.g, nextSeq: value.n }
  } catch {
    return null
  }
}

/** Opaque URL-safe cursor for paging toward the beginning of one history generation. */
export function encodeSessionHistoryPageCursor(c: SessionHistoryPageCursor): string {
  const json = JSON.stringify({ v: 1, g: c.generation, b: c.beforeSeq })
  const bytes = new TextEncoder().encode(json)
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

/** Decode a history-page cursor, rejecting malformed or unsupported positions. */
export function decodeSessionHistoryPageCursor(s: string): SessionHistoryPageCursor | null {
  try {
    if (!s || !/^[A-Za-z0-9_-]+$/.test(s)) return null
    const base64 = s.replace(/-/g, "+").replace(/_/g, "/")
    const padded = base64 + "=".repeat((4 - base64.length % 4) % 4)
    const binary = atob(padded)
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
    const value = JSON.parse(new TextDecoder().decode(bytes)) as { v?: unknown; g?: unknown; b?: unknown }
    if (value.v !== 1 || typeof value.g !== "string" || !value.g) return null
    if (typeof value.b !== "number" || !Number.isInteger(value.b) || value.b < 0) return null
    return { generation: value.g, beforeSeq: value.b }
  } catch {
    return null
  }
}

export type SessionEventStreamFrame =
  | { kind: "event"; seq: number; cursor: SessionEventCursor; event: AgentEvent }
  | { kind: "live"; event: AgentEvent }
  | { kind: "replay-end"; cursor: SessionEventCursor }
  | { kind: "replay-reset"; reason: "history-rewritten" | "cursor-ahead"; cursor: SessionEventCursor }

export function sessionEventsUrl(id: string, opts?: { cursor?: string }): string {
  const cursor = opts?.cursor ? `&cursor=${encodeURIComponent(opts.cursor)}` : ""
  return `${ROUTES.events(id)}?stream=v2${cursor}`
}

/** Serialize one named v2 session-event stream frame. */
export function sseFrame(frame: SessionEventStreamFrame): string {
  if (frame.kind === "event") {
    return `event: session.event\nid: ${encodeSessionEventCursor(frame.cursor)}\ndata: ${JSON.stringify({ seq: frame.seq, event: frame.event })}\n\n`
  }
  if (frame.kind === "live") {
    return `event: session.live\ndata: ${JSON.stringify({ event: frame.event })}\n\n`
  }
  if (frame.kind === "replay-end") {
    return `event: replay.end\ndata: ${JSON.stringify({ cursor: frame.cursor })}\n\n`
  }
  return `event: replay.reset\ndata: ${JSON.stringify({ reason: frame.reason, cursor: frame.cursor })}\n\n`
}

/** Parse both v2 named frames and unnamed legacy AgentEvent frames. */
export async function* readSessionEventStream(
  res: Response,
): AsyncGenerator<SessionEventStreamFrame | { kind: "legacy"; event: AgentEvent }> {
  if (!res.body) return
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  const parse = (raw: string): SessionEventStreamFrame | { kind: "legacy"; event: AgentEvent } | null => {
    let name: string | undefined
    let id: string | undefined
    const data: string[] = []
    for (const line of raw.split("\n")) {
      if (!line || line.startsWith(":")) continue
      const colon = line.indexOf(":")
      const field = colon < 0 ? line : line.slice(0, colon)
      let value = colon < 0 ? "" : line.slice(colon + 1)
      if (value.startsWith(" ")) value = value.slice(1)
      if (field === "event") name = value
      else if (field === "id") id = value
      else if (field === "data") data.push(value)
    }
    if (data.length === 0) return null
    try {
      const value = JSON.parse(data.join("\n")) as any
      if (!name) return { kind: "legacy", event: value as AgentEvent }
      if (name === "session.event") {
        const cursor = id ? decodeSessionEventCursor(id) : null
        if (!cursor || !Number.isInteger(value?.seq) || value.seq < 0 || !value?.event) return null
        return { kind: "event", seq: value.seq, cursor, event: value.event as AgentEvent }
      }
      if (name === "session.live" && value?.event) return { kind: "live", event: value.event as AgentEvent }
      if (name === "replay.end") {
        const cursor = validCursorValue(value?.cursor)
        return cursor ? { kind: "replay-end", cursor } : null
      }
      if (name === "replay.reset") {
        const cursor = validCursorValue(value?.cursor)
        const reason = value?.reason
        return cursor && (reason === "history-rewritten" || reason === "cursor-ahead")
          ? { kind: "replay-reset", reason, cursor }
          : null
      }
    } catch {
      return null
    }
    return null
  }
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true }).replace(/\r/g, "")
      let index: number
      while ((index = buffer.indexOf("\n\n")) !== -1) {
        const frame = parse(buffer.slice(0, index))
        buffer = buffer.slice(index + 2)
        if (frame) yield frame
      }
    }
    buffer += decoder.decode().replace(/\r/g, "")
    if (buffer) {
      const frame = parse(buffer)
      if (frame) yield frame
    }
  } finally {
    reader.releaseLock()
  }
}

function validCursorValue(value: unknown): SessionEventCursor | null {
  if (!value || typeof value !== "object") return null
  const cursor = value as { generation?: unknown; nextSeq?: unknown }
  if (typeof cursor.generation !== "string" || !cursor.generation) return null
  if (typeof cursor.nextSeq !== "number" || !Number.isInteger(cursor.nextSeq) || cursor.nextSeq < 0) return null
  return { generation: cursor.generation, nextSeq: cursor.nextSeq }
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
