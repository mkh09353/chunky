// Real nested threads. A ThreadManager turns a `spawn_thread` request into a
// FULL, independent agent turn: it mints a childThreadId, runs `agent.stream`
// on its OWN LangGraph `thread_id = childThreadId` (its own checkpointer entry),
// pipes that stream through the shared `translateStream` tagged with the child's
// id, and brackets it with `thread.spawn` + `thread.status running/idle/cancelled`. Because
// each spawn is a real independent agent run whose model also has `spawn_thread`,
// children can spawn children (recursion). All events flow over the existing
// session SSE — no new routes.
import { randomUUID } from "node:crypto"
import { AsyncLocalStorageProviderSingleton } from "@langchain/core/singletons"
import type { AgentEvent, StopDelegateRequest, StopDelegateResponse } from "@chunky/protocol"
import type { Emit } from "./event-emitter.ts"
import { translateStream } from "./run.ts"
import { getAdvisorAgent, getAgent, getReviewAgent, getSidekickAgent, RECURSION_LIMIT } from "./agent.ts"
import { ADVISOR_SYSTEM_PROMPT, REVIEW_SYSTEM_PROMPT, sidekickSystemPrompt } from "./prompt.ts"
import { distilledAgentsMd } from "./agents-md.ts"
import { readRepoMemory } from "./memory.ts"
import {
  activeSelection,
  childSelection,
  getProvider,
  listSidekickSeats,
  providerRuntime,
  resolveAdvisorSelection,
  resolveReviewSelection,
  resolveSidekickSeat,
  sidekickFor,
  type AgentSelection,
  type AgentSelectionOverride,
} from "./providers/registry.ts"
import { registerThread, unregisterThread, type ThreadSpawner } from "./thread-context.ts"
import { LAUNCH_WORKSPACE } from "./workspace.ts"
import { assertSelectionAllowed, isIncognitoSession } from "./incognito.ts"
import { notifySessionChanged } from "./session-changes.ts"
import { registerIncognitoThread } from "./bun-sqlite-saver.ts"
import { runWorkflowScript, workflowConcurrency, type WorkflowHost, type WorkflowTier } from "./workflow/engine.ts"
import { annotateWorkflowResult, prepareJournaledHost, WorkflowJournalError } from "./workflow/journal.ts"
import { workflowRouteResolver } from "./workflow/router.ts"
import { streamWithCheckpointRecovery } from "./checkpoint-recovery.ts"
import { createDelegateWatchdog } from "./watchdog.ts"
import {
  DELEGATE_TRANSPORT_RETRY_PROMPT,
  isTransientDelegateFailure,
  shouldRetryDelegate,
  transientFailureReason,
} from "./transient-failure.ts"
import { Store } from "./store.ts"
import { appendReminder } from "./tasks.ts"
import { routeBackgroundNotice } from "./background-dispatch.ts"
import {
  abortDetachedSpawn,
  createDetachedSpawn,
  detachedSpawnLimit,
  finishDetachedSpawn,
  getDetachedSpawn,
  isCancelledDelegateReport,
  listDetachedSpawns,
  type DetachedSpawnRecord,
} from "./detached-spawns.ts"
import { discardSidekickCandidate, recordSidekickComplete, recordSidekickStart, type EvalBriefStruct } from "./eval-recorder.ts"

/** Reasoning-effort cap for `big`-tier workflow agents: keep a lower configured
 *  effort, clamp anything at/above medium (or unset) to medium. */
const EFFORT_RANK: Record<string, number> = { low: 0, medium: 1, high: 2, xhigh: 3, max: 4 }
export function capEffortAtMedium(effort: string | undefined): "low" | "medium" {
  return effort && (EFFORT_RANK[effort] ?? 1) < 1 ? (effort as "low") : "medium"
}

/** The narrow part of a compiled agent that ThreadManager needs. Keeping this
 * structural lets the deterministic thread test inject a fake stream without
 * model credentials. */
export interface StreamableAgent {
  stream(...args: any[]): Promise<AsyncIterable<unknown>>
}

export type AgentForSelection = (selection: AgentSelection, workspace: string, agentsMd?: string | null, sessionId?: string, repoMemory?: string | null) => StreamableAgent

/** Per-session advisor-consult tally, keyed by root session id. A fresh
 *  ThreadManager is built per turn (run.ts), so this lives module-level to
 *  survive across turns and count how often the executor reaches for the advisor
 *  over a whole session — the signal for whether the prompt nudge is calibrated
 *  (used for hard calls, not for everything). Entries are tiny (id → count) and
 *  a session-scoped local tool, so the map is never pruned. */
const advisorConsultsBySession = new Map<string, number>()

/** How many times the advisor has been consulted in this session so far. */
export function advisorConsultCount(sessionId: string): number {
  return advisorConsultsBySession.get(sessionId) ?? 0
}

/** Per-session sidekick-handoff tally, keyed by root session id. Same shape and
 *  rationale as advisorConsultsBySession: the signal for whether the lead is
 *  delegating the hands-on loop (the Fusion management-style metric) or doing
 *  everything itself. */
const sidekickHandoffsBySession = new Map<string, number>()
const activeSidekicks = new Map<string, Map<string, { seat: string; brief: string }>>()
const runningChildrenBySession = new Map<string, Map<string, { threadId: string; title: string }>>()
const sidekickSeatTails = new Map<string, Promise<void>>()
/** Seats with a detached sidekick brief still in flight. Keyed by root session
 * because detached work can outlive the originating ThreadManager registration. */
const detachedSidekickSeats = new Map<string, Set<string>>()

export const CANCELLED_BY_USER = "cancelled by user"
export const CANCELLED_BY_LEAD = "cancelled by lead"

function cancelledReason(source: "user" | "lead"): string {
  return source === "lead" ? CANCELLED_BY_LEAD : CANCELLED_BY_USER
}

function isCancelledReason(text: string): boolean {
  return isCancelledDelegateReport(text)
}

interface LiveDelegateHandle {
  kind: "sidekick" | "child" | "advisor"
  sessionId: string
  threadId: string
  seat?: string
  title: string
  startedAt: number
  abort: (reason: string) => void
  done: Promise<void>
}

export interface LiveDelegateStatus {
  kind: "sidekick" | "spawn_thread"
  sessionId: string
  threadId: string
  seat?: string
  title: string
  startedAt: number
  done: Promise<void>
}

/** Read-only view of the existing live-delegate registry. */
export function listLiveDelegateStatuses(sessionId: string): LiveDelegateStatus[] {
  return [...liveDelegates.values()]
    .filter((handle) => handle.sessionId === sessionId && handle.kind !== "advisor")
    .map((handle) => ({
      kind: handle.kind === "child" ? "spawn_thread" : "sidekick",
      sessionId: handle.sessionId,
      threadId: handle.threadId,
      ...(handle.seat ? { seat: handle.seat } : {}),
      title: handle.title,
      startedAt: handle.startedAt,
      done: handle.done,
    }))
}

const liveDelegates = new Map<string, LiveDelegateHandle>()
const lastTerminalSidekick = new Map<string, { seat: string; threadId: string; status: "cancelled" | "completed" | "failed"; at: number }>()
const TERMINAL_SIDEKICK_TTL_MS = 30 * 60_000

function liveSidekickKey(sessionId: string, seat: string): string {
  return `${sessionId}\0sidekick\0${seat}`
}

function liveChildKey(sessionId: string, threadId: string): string {
  return `${sessionId}\0child\0${threadId}`
}

function liveAdvisorKey(sessionId: string): string {
  return `${sessionId}\0advisor`
}

function registerLiveDelegate(handle: LiveDelegateHandle): void {
  const key = handle.kind === "sidekick"
    ? liveSidekickKey(handle.sessionId, handle.seat ?? "default")
    : handle.kind === "advisor"
      ? liveAdvisorKey(handle.sessionId)
      : liveChildKey(handle.sessionId, handle.threadId)
  liveDelegates.set(key, handle)
  // A detach=true / STEER-detach record may already exist (created before the
  // worker's first await). Bind its abort to THIS handle only when the record
  // names this exact worker — never every other child in the session.
  for (const record of listDetachedSpawns(handle.sessionId)) {
    if (record.status !== "running") continue
    if (!recordMatchesHandle(record, handle)) continue
    attachRecordAbortToHandle(record, handle)
  }
}

function unregisterLiveDelegate(handle: LiveDelegateHandle): void {
  const key = handle.kind === "sidekick"
    ? liveSidekickKey(handle.sessionId, handle.seat ?? "default")
    : handle.kind === "advisor"
      ? liveAdvisorKey(handle.sessionId)
      : liveChildKey(handle.sessionId, handle.threadId)
  if (liveDelegates.get(key) === handle) liveDelegates.delete(key)
}

function terminalThreadStatus(text: string): "idle" | "cancelled" {
  return isCancelledReason(text) ? "cancelled" : "idle"
}

function reportIsOk(text: string): boolean {
  return !isCancelledReason(text) && !/^error(?: \(after 1 retry\))?:/.test(text)
}

function completeDelegationFromReport(id: string, text: string): void {
  if (isCancelledReason(text)) Store.completeDelegation(id, "cancelled")
  else Store.completeDelegation(id, reportIsOk(text))
}

function emitDelegateFailure(emit: Emit, threadId: string, message: string, cancelled: boolean): void {
  if (cancelled) return
  emit({ type: "error", message, threadId } as AgentEvent)
}

function abortReasonText(signal: AbortSignal, fallback: string): string {
  if (signal.reason instanceof Error && signal.reason.message) return signal.reason.message
  if (typeof signal.reason === "string" && signal.reason.trim()) return signal.reason
  return fallback
}

function attachRecordAbortToHandle(record: DetachedSpawnRecord, handle: LiveDelegateHandle): void {
  const fanIn = () => {
    handle.abort(abortReasonText(record.abort.signal, "cancelled by user"))
  }
  record.abort.signal.addEventListener("abort", fanIn, { once: true })
  if (record.abort.signal.aborted) fanIn()
}

/** The live worker this detached record is allowed to abort. Sidekicks match
 *  by seat (their detached childThreadId is bookkeeping). Children match by
 *  exact thread id. Advisors and every other sibling stay untouched. */
function recordMatchesHandle(record: DetachedSpawnRecord, handle: LiveDelegateHandle): boolean {
  if (handle.sessionId !== record.sessionId) return false
  if (record.kind === "sidekick" || handle.kind === "sidekick") {
    return handle.kind === "sidekick"
      && record.kind === "sidekick"
      && (handle.seat ?? "default") === (record.seat ?? "default")
  }
  if (handle.kind !== "child") return false
  return handle.threadId === record.childThreadId
}

function fanDetachedAbortIntoLiveDogs(record: DetachedSpawnRecord): void {
  for (const handle of liveDelegates.values()) {
    if (!recordMatchesHandle(record, handle)) continue
    attachRecordAbortToHandle(record, handle)
  }
}

/** spawn() promises carry the child thread id so a later STEER-detach record
 *  can name that exact worker instead of every live child in the session. */
const workThreadIds = new WeakMap<Promise<string>, string>()

function bindWorkThread(work: Promise<string>, threadId: string): void {
  workThreadIds.set(work, threadId)
}

function threadIdOfWork(work: Promise<string> | (() => Promise<string>)): string | undefined {
  return typeof work === "function" ? undefined : workThreadIds.get(work)
}

function rememberTerminalSidekick(sessionId: string, seat: string, threadId: string, status: "cancelled" | "completed" | "failed"): void {
  lastTerminalSidekick.set(liveSidekickKey(sessionId, seat), { seat, threadId, status, at: Date.now() })
}

function rememberedTerminalSidekick(sessionId: string, seat: string): { seat: string; threadId: string; status: "cancelled" | "completed" | "failed" } | undefined {
  const key = liveSidekickKey(sessionId, seat)
  const remembered = lastTerminalSidekick.get(key)
  if (!remembered) return undefined
  if (Date.now() - remembered.at >= TERMINAL_SIDEKICK_TTL_MS) {
    lastTerminalSidekick.delete(key)
    return undefined
  }
  return remembered
}

function abortLiveAndDetached(live: LiveDelegateHandle | undefined, records: DetachedSpawnRecord[], reason: string): void {
  for (const record of records) abortDetachedSpawn(record, reason)
  live?.abort(reason)
}

export function resetLiveDelegatesForTests(): void {
  liveDelegates.clear()
  lastTerminalSidekick.clear()
}

/** Cancel a live sync delegate (watchdog only) or a detached spawn. Never
 *  touches the lead-turn / ThreadManager abort controller. */
export async function stopDelegate(
  sessionId: string,
  target: StopDelegateRequest = {},
  source: "user" | "lead" = "user",
): Promise<StopDelegateResponse> {
  const reason = cancelledReason(source)
  const runId = target.runId?.trim()
  if (runId) {
    const record = getDetachedSpawn(sessionId, runId)
    if (!record) return { outcome: "not-found", runId, message: `error: no detached run "${runId}" in this session.` }
    if (record.status !== "running") {
      return {
        outcome: "already-finished",
        status: record.status === "cancelled" || record.status === "completed" || record.status === "failed" ? record.status : "failed",
        runId: record.id,
        seat: record.seat,
        threadId: record.childThreadId,
        message: `${record.title} already finished (${record.status}).`,
      }
    }
    abortDetachedSpawn(record, reason)
    return {
      outcome: "cancelled",
      status: "cancelled",
      runId: record.id,
      seat: record.seat,
      threadId: record.childThreadId,
      message: `${record.title} ${reason}.`,
    }
  }

  const seat = target.seat?.trim() || "default"
  const live = liveDelegates.get(liveSidekickKey(sessionId, seat))
  const detached = listDetachedSpawns(sessionId).filter((record) =>
    record.status === "running"
    && record.kind === "sidekick"
    && (record.seat ?? "default") === seat)
  const sameWorker = Boolean(live && detached.length === 1)
  const runningCount = (live ? 1 : 0) + detached.length
  if (runningCount > 1 && !sameWorker) {
    return { outcome: "ambiguous", seat, message: `error: multiple live delegates on seat "${seat}" — pass runId.` }
  }
  if (live || detached.length === 1) {
    const record = detached[0]
    abortLiveAndDetached(live, detached, reason)
    return {
      outcome: "cancelled",
      status: "cancelled",
      runId: record?.id,
      seat,
      threadId: live?.threadId ?? record?.childThreadId,
      message: live
        ? `Sidekick${seat === "default" ? "" : ` (${seat})`} ${reason}.`
        : `${record!.title} ${reason}.`,
    }
  }
  const finishedDetached = listDetachedSpawns(sessionId).filter((record) =>
    record.status !== "running"
    && record.kind === "sidekick"
    && (record.seat ?? "default") === seat)
  if (finishedDetached.length === 1) {
    const record = finishedDetached[0]!
    return {
      outcome: "already-finished",
      status: record.status === "cancelled" || record.status === "completed" || record.status === "failed" ? record.status : "failed",
      runId: record.id,
      seat,
      threadId: record.childThreadId,
      message: `${record.title} already finished (${record.status}).`,
    }
  }
  const remembered = rememberedTerminalSidekick(sessionId, seat)
  if (remembered) {
    return {
      outcome: "already-finished",
      status: remembered.status,
      seat,
      threadId: remembered.threadId,
      message: `Sidekick${seat === "default" ? "" : ` (${seat})`} already finished (${remembered.status}).`,
    }
  }
  return {
    outcome: "not-found",
    seat,
    message: seat === "default"
      ? "error: no live default-seat sidekick to stop (pass runId for a detached child, or a named seat)."
      : `error: no live sidekick on seat "${seat}".`,
  }
}

/** How many briefs the sidekick has been handed in this session so far. */
export function sidekickHandoffCount(sessionId: string): number {
  return sidekickHandoffsBySession.get(sessionId) ?? 0
}
export function activeSidekickSummaries(sessionId: string): { seat: string; brief: string }[] {
  return [...(activeSidekicks.get(sessionId)?.values() ?? [])].map((value) => ({ ...value }))
}
export function runningChildSummaries(sessionId: string): { threadId: string; title: string }[] {
  return [...(runningChildrenBySession.get(sessionId)?.values() ?? [])].map((value) => ({ ...value }))
}

/** Live delegate activity only; background tasks and monitors are intentionally excluded. */
export function hasLiveThreadDelegates(sessionId: string): boolean {
  return (runningChildrenBySession.get(sessionId)?.size ?? 0) > 0 ||
    (activeSidekicks.get(sessionId)?.size ?? 0) > 0
}

/** Cheap cross-session live-delegate count for resource samples. */
export function liveDelegateCount(): number {
  let n = 0
  for (const map of runningChildrenBySession.values()) n += map.size
  for (const map of activeSidekicks.values()) n += map.size
  return n
}

export class ThreadManager implements ThreadSpawner {
  private readonly rootId: string
  private readonly emit: Emit
  /** The root session id (ThreadSpawner contract) — every child resolves here. */
  get sessionId(): string {
    return this.rootId
  }
  private readonly agentFor: AgentForSelection
  private readonly advisorAgentFor: AgentForSelection
  private readonly reviewAgentFor: AgentForSelection
  private readonly sidekickAgentFor: AgentForSelection
  /** Injected agent factories own their own readiness contract. Only the real
   *  provider-backed factories should consult Chunky's persisted OAuth state. */
  private readonly preflightAgentProvider: boolean
  private readonly preflightAdvisorProvider: boolean
  private readonly preflightReviewProvider: boolean
  private readonly preflightSidekickProvider: boolean
  private readonly selections = new Map<string, AgentSelection>()
  /** The session's workspace: every child thread and advisor consult runs here —
   *  a child can never escape into another repo's folder. */
  readonly workspace: string
  /** The turn's abort controller (from run.ts). Threaded into EVERY child and
   *  advisor stream so an Esc/interrupt tears them down too — without it a stalled
   *  advisor/child consult hangs the whole turn un-interruptibly (the root signal
   *  never reaches the child's stream, so the awaited tool promise never settles). */
  private readonly abort?: AbortController
  /** Session-scoped abort for a detached workflow run. Survives the originating
   *  turn so agent() children keep working after dispose(); resetDetachedSpawns
   *  (server shutdown) and the detached-spawn record abort this instead. */
  private workflowAbort?: AbortController
  private disposed = false
  private readonly runningChildren = new Map<string, { threadId: string; title: string }>()
  private readonly steerDetach = new Set<() => void>()

  runningChildSummaries(): { threadId: string; title: string }[] { return [...this.runningChildren.values()] }

  constructor(
    emit: Emit,
    rootId: string,
    rootSelection: AgentSelection = activeSelection(),
    agentFor: AgentForSelection = getAgent,
    advisorAgentFor: AgentForSelection = getAdvisorAgent,
    workspace: string = LAUNCH_WORKSPACE,
    abort?: AbortController,
    sidekickAgentFor: AgentForSelection = getSidekickAgent,
    reviewAgentFor: AgentForSelection = getReviewAgent,
  ) {
    this.emit = emit
    this.rootId = rootId
    this.agentFor = agentFor
    this.advisorAgentFor = advisorAgentFor
    this.reviewAgentFor = reviewAgentFor
    this.sidekickAgentFor = sidekickAgentFor
    this.preflightAgentProvider = agentFor === getAgent
    this.preflightAdvisorProvider = advisorAgentFor === getAdvisorAgent
    this.preflightReviewProvider = reviewAgentFor === getReviewAgent
    this.preflightSidekickProvider = sidekickAgentFor === getSidekickAgent
    this.workspace = workspace
    this.abort = abort
    this.selections.set(rootId, rootSelection)
    // The root (main session) thread resolves to this manager, so the main
    // model's spawn_thread calls are routed here.
    registerThread(rootId, this)
  }

  /** Release the root registration when the session turn ends. */
  dispose(): void {
    this.disposed = true
    unregisterThread(this.rootId)
    // Detached children remain registered until their own finally block. Keep
    // their captured selection so their full child toolset (including nested
    // spawn_thread) continues to work after the originating root turn ends.
    // A detached workflow may still spawn() after the turn ends; keep the root
    // selection until that run restores workflowAbort so children inherit it.
    if (!this.workflowAbort) this.selections.delete(this.rootId)
  }

  detachForSteer(): boolean {
    if (!this.steerDetach.size) return false
    const pending = [...this.steerDetach]
    this.steerDetach.clear()
    for (const detach of pending) detach()
    return true
  }

  async runSteerDetachable(
    kind: "sidekick" | "spawn_thread" | "workflow",
    title: string,
    workOrStart: Promise<string> | (() => Promise<string>),
    options: { detach?: boolean; seat?: string } = {},
  ): Promise<string> {
    const seat = options.seat?.trim() || "default"
    if (kind === "sidekick" && detachedSidekickSeats.get(this.rootId)?.has(seat)) {
      return `error: seat "${seat}" has a detached brief in flight — wait for its report or route to another seat`
    }

    // A thunk lets explicit sidekick detach claim its seat before starting work,
    // so a same-turn duplicate cannot slip into the persistent seat queue.
    if (options.detach) return this.detachDelegate(kind, title, workOrStart, "requested", seat)
    const work = typeof workOrStart === "function" ? workOrStart() : workOrStart

    let detach!: () => void
    const detached = new Promise<void>((resolve) => { detach = resolve })
    this.steerDetach.add(detach)
    const winner = await Promise.race([
      work.then((report) => ({ detached: false as const, report })),
      detached.then(() => ({ detached: true as const, report: "" })),
    ])
    this.steerDetach.delete(detach)
    if (!winner.detached) return winner.report

    return this.detachDelegate(kind, title, work, "steer", seat)
  }

  /** Shared detached-spawn lifecycle and report routing for explicit detach and
   * STEER detach. */
  private detachDelegate(
    kind: "sidekick" | "spawn_thread" | "workflow",
    title: string,
    workOrStart: Promise<string> | (() => Promise<string>),
    reason: "requested" | "steer",
    seat: string,
  ): string {
    if (kind === "sidekick") {
      let seats = detachedSidekickSeats.get(this.rootId)
      if (!seats) { seats = new Set(); detachedSidekickSeats.set(this.rootId, seats) }
      seats.add(seat)
    }
    const clearSeatGuard = () => {
      if (kind !== "sidekick") return
      const seats = detachedSidekickSeats.get(this.rootId)
      seats?.delete(seat)
      if (seats?.size === 0) detachedSidekickSeats.delete(this.rootId)
    }
    const boundThreadId = threadIdOfWork(workOrStart)
    const childThreadId = boundThreadId
      ?? (kind === "sidekick"
        ? `${this.rootId}:sidekick${seat === "default" ? "" : `:${seat}`}`
        : `${this.rootId}:${kind}:${randomUUID()}`)
    const record = createDetachedSpawn(this.rootId, childThreadId, title, true, { kind, seat })!
    const reasonText = reason === "steer" ? "detached by steer" : "detached"
    // Detached workflow children must not die with the originating turn abort.
    // Parent them to the detached-spawn record (same as launchDetachedSpawn).
    // Server shutdown still cancels via resetDetachedSpawns → record.abort.
    const previousWorkflowAbort = kind === "workflow" ? this.workflowAbort : undefined
    if (kind === "workflow") this.workflowAbort = record.abort
    let work: Promise<string>
    try {
      work = typeof workOrStart === "function" ? workOrStart() : workOrStart
    } catch (err) {
      work = Promise.reject(err)
    }
    // Explicit detach / STEER-detach start the worker against the lead abort.
    // Bind record.abort to the one matching live dog so stop_delegate(runId)
    // reaches that worker without touching the lead or a sibling.
    fanDetachedAbortIntoLiveDogs(record)
    const restoreWorkflowAbort = () => {
      if (kind === "workflow" && this.workflowAbort === record.abort) {
        this.workflowAbort = previousWorkflowAbort
        if (this.disposed && !this.workflowAbort) this.selections.delete(this.rootId)
      }
    }
    void work.then((report) => {
      finishDetachedSpawn(record, report)
      try {
        const reminder = `${title} ${reasonText} (${record.id}) finished. Report:\n${record.result}`
        const wakePrompt = `${reminder}\n\nAssess this detached delegate report and act on any valid findings before finalizing.`
        if (routeBackgroundNotice(this.rootId, wakePrompt, `${title} ${reasonText} finished.`, kind, { kind, detachedSpawnId: record.id }) === "reminder") appendReminder(this.rootId, reminder)
      } finally {
        restoreWorkflowAbort()
        clearSeatGuard()
      }
    }, (err) => {
      const raw = (err as Error)?.message ?? String(err)
      const cancelled = record.abort.signal.aborted || isCancelledDelegateReport(raw)
      const report = cancelled ? (isCancelledDelegateReport(raw) ? raw.replace(/^error:\s*/i, "") : raw) : `error: ${raw}`
      finishDetachedSpawn(record, report)
      try {
        const verb = cancelled ? "cancelled" : "failed"
        const reminder = `${title} ${reasonText} (${record.id}) ${verb}. Report:\n${record.result}`
        if (routeBackgroundNotice(this.rootId, reminder, `${title} ${reasonText} ${verb}.`, kind, { kind, detachedSpawnId: record.id }) === "reminder") appendReminder(this.rootId, reminder)
      } finally {
        restoreWorkflowAbort()
        clearSeatGuard()
      }
    })
    return `${title} ${reasonText}; the worker continues and its report will arrive as a wake/reminder. Run id: ${record.id}.`
  }

  /**
   * Run a full child agent turn for `instructions` on a fresh threadId and
   * stream it over the session SSE. Returns the child's final assistant text.
   * `callerThreadId` is the thread whose model requested the spawn: if it is the
   * root, the child links to the main thread (parentThreadId=null); otherwise the
   * child nests under the caller (deeper recursion).
   */
  /** An empty report from a delegate is always a failure mode, never an answer:
   *  returning "" renders as "completed with no output" and leaves the lead (and
   *  the user) with zero signal about what happened. Replace it with an explicit,
   *  actionable error string. */
  private static nonEmptyReport(text: string, who: string): string {
    if (text.trim() !== "") return text
    return `error: ${who} finished without producing any output — its run likely failed or was cut off mid-stream. Check the ${who} thread for errors and re-send the brief (or split it smaller).`
  }

  spawn(opts: {
    callerThreadId: string
    title: string
    instructions: string
    selection?: AgentSelectionOverride
    kind?: "child" | "workflow_agent"
  }): Promise<string> {
    const childThreadId = `child-${randomUUID()}`
    const running = this.spawnOnThread(childThreadId, opts)
    bindWorkThread(running, childThreadId)
    return running
  }

  private async spawnOnThread(childThreadId: string, opts: {
    callerThreadId: string
    title: string
    instructions: string
    selection?: AgentSelectionOverride
    kind?: "child" | "workflow_agent"
  }): Promise<string> {
    if (isIncognitoSession(this.rootId)) registerIncognitoThread(childThreadId)
    const parentThreadId = opts.callerThreadId === this.rootId ? null : opts.callerThreadId
    // A detached workflow can keep spawning after dispose() drops the root
    // selection. Fall back to the live /model choice so children still inherit.
    const parentSelection = this.selections.get(opts.callerThreadId) ?? (opts.callerThreadId === this.rootId ? activeSelection() : undefined)
    if (!parentSelection) {
      throw new Error(`missing model selection for caller thread ${opts.callerThreadId}`)
    }
    const selection = childSelection(parentSelection, opts.selection)
    assertSelectionAllowed(this.rootId, selection)
    const delegationId = randomUUID()
    Store.createDelegation({ id: delegationId, sessionId: this.rootId, kind: opts.kind ?? "child", provider: selection.provider, model: selection.model ?? "unknown", effort: selection.effort ?? undefined, briefSnippet: opts.instructions })

    // Fail fast if the child's provider sign-in is expired: a stalled auth would
    // otherwise hang the child stream with no clear cause. Mirrors run.ts's
    // root-turn preflight, which never ran for spawned children.
    if (this.preflightAgentProvider) {
      try {
        await getProvider(selection.provider)?.ensureAuth?.()
      } catch (err) {
        const detail = (err as Error)?.message ?? String(err)
        return `error: provider "${selection.provider}" sign-in expired — run /login to re-authenticate. (${detail})`
      }
    }

    // The child is itself a valid spawn context, so grandchildren route correctly.
    registerThread(childThreadId, this)
    this.selections.set(childThreadId, selection)

    this.emit({ type: "thread.spawn", threadId: childThreadId, parentThreadId, title: opts.title, model: selection.model })
    this.emit({ type: "thread.status", threadId: childThreadId, status: "running", title: opts.title })
    this.runningChildren.set(childThreadId, { threadId: childThreadId, title: opts.title })
    let sessionChildren = runningChildrenBySession.get(this.rootId)
    if (!sessionChildren) { sessionChildren = new Map(); runningChildrenBySession.set(this.rootId, sessionChildren) }
    sessionChildren.set(childThreadId, { threadId: childThreadId, title: opts.title })
    // A delegate starting/stopping changes the session's `busy`, which the
    // compact session stream publishes. Without this the stream would report a
    // session idle while a child is still working.
    notifySessionChanged(this.rootId)

    // Inactivity watchdog: if the child's stream goes silent (stalled provider
    // connection), abort it and hand the lead a real error instead of hanging
    // the awaited tool promise forever. Every event the child emits resets it.
    // One in-place retry covers a classified transport drop (empty completion,
    // socket close, watchdog stall) so the lead is not the retry loop.
    const parentAbort = this.workflowAbort ?? this.abort
    let dog = createDelegateWatchdog({ emit: this.emit, label: `child thread "${opts.title}"`, parent: parentAbort })
    let result = ""
    let resolveLive!: () => void
    const live: LiveDelegateHandle = {
      kind: "child",
      sessionId: this.rootId,
      threadId: childThreadId,
      title: opts.title,
      startedAt: Date.now(),
      abort: (reason) => dog.abort.abort(new Error(reason)),
      done: new Promise<void>((resolve) => { resolveLive = resolve }),
    }
    registerLiveDelegate(live)
    try {
      const runChild = async (prompt: string, recover: boolean): Promise<string> => {
        if (providerRuntime(selection.provider) === "anthropic-sdk") {
          const { runAnthropicAgent } = await import("./anthropic-runner.ts")
          return ThreadManager.nonEmptyReport(
            await runAnthropicAgent({
              selection,
              threadId: childThreadId,
              prompt,
              emit: dog.emit,
              eventThreadId: childThreadId,
              freshSession: !recover,
              workspace: this.workspace,
              repositoryLess: Store.repositoryScopeOf(this.rootId) === "none",
              abort: dog.abort,
              usageContext: { sessionId: this.rootId, role: "child", delegationId },
            }),
            "child thread",
          )
        }

        // A child spawned from inside the parent's tool node runs on the parent's
        // ambient callback context, which would leak the child's LLM tokens into
        // the PARENT's `messages` stream (duplicated, untagged). Create the child
        // stream with a cleared async-local store so it is fully isolated: the
        // child streams only through its OWN iterator, tagged with its threadId.
        // Retry re-enters the same thread_id; checkpoint recovery strips a tool
        // call that was persisted without its matching ToolMessage.
        const agent = this.agentFor(selection, this.workspace, undefined, this.rootId)
        const config = {
          configurable: { thread_id: childThreadId, workspace: this.workspace },
          streamMode: ["updates", "messages"],
          recursionLimit: RECURSION_LIMIT,
          signal: dog.abort.signal,
        } as any
        const stream = await AsyncLocalStorageProviderSingleton.getInstance().run(undefined, () =>
          recover
            ? streamWithCheckpointRecovery(agent, { messages: [{ role: "user", content: prompt }] }, config)
            : agent.stream({ messages: [{ role: "user", content: prompt }] }, config),
        )
        return `${ThreadManager.nonEmptyReport(await translateStream(stream, childThreadId, dog.emit, undefined, undefined, { sessionId: this.rootId, selection, role: "child", delegationId }), "child thread")}\n\n[delegation: ${delegationId}]`
      }

      try {
        result = await runChild(opts.instructions, false)
      } catch (err) {
        const userAborted = Boolean(parentAbort?.signal.aborted)
        const cancelled = !userAborted && dog.abort.signal.aborted && !dog.timedOut()
        const message = dog.timedOut() ? dog.timeoutMessage() : cancelled ? (dog.abort.signal.reason instanceof Error ? dog.abort.signal.reason.message : String(dog.abort.signal.reason ?? "cancelled by user")) : ((err as Error)?.message ?? String(err))
        if (!shouldRetryDelegate({
          attempt: 0,
          transient: isTransientDelegateFailure(err, dog, { userAborted }),
          userAborted,
        })) {
          emitDelegateFailure(this.emit, childThreadId, message, cancelled)
          result = cancelled ? message : `error: ${message}`
        } else {
          this.emit({
            type: "error",
            message: `transport failure (${transientFailureReason(err, dog)}) — retrying once`,
            threadId: childThreadId,
          } as AgentEvent)
          dog.dispose()
          dog = createDelegateWatchdog({ emit: this.emit, label: `child thread "${opts.title}"`, parent: parentAbort })
          live.abort = (reason) => dog.abort.abort(new Error(reason))
          try {
            result = await runChild(DELEGATE_TRANSPORT_RETRY_PROMPT, true)
          } catch (retryErr) {
            const retryMessage = dog.timedOut() ? dog.timeoutMessage() : ((retryErr as Error)?.message ?? String(retryErr))
            this.emit({ type: "error", message: retryMessage, threadId: childThreadId } as AgentEvent)
            result = `error (after 1 retry): ${retryMessage}`
          }
        }
      }
      return result
    } finally {
      completeDelegationFromReport(delegationId, result)
      dog.dispose()
      unregisterLiveDelegate(live)
      resolveLive()
      this.emit({ type: "thread.status", threadId: childThreadId, status: terminalThreadStatus(result), title: opts.title })
      unregisterThread(childThreadId)
      this.selections.delete(childThreadId)
      this.runningChildren.delete(childThreadId)
      const sessionChildren = runningChildrenBySession.get(this.rootId)
      sessionChildren?.delete(childThreadId)
      if (sessionChildren?.size === 0) runningChildrenBySession.delete(this.rootId)
      notifySessionChanged(this.rootId)
    }

  }

  /** Start an independent child run without awaiting it. All mutable run inputs
   * are selected before this returns: the originating manager may be disposed
   * when the root turn ends, but this child owns its controller and stream. */
  launchDetachedSpawn(opts: {
    callerThreadId: string
    title: string
    instructions: string
    selection?: AgentSelectionOverride
  }): string {
    const parentSelection = this.selections.get(opts.callerThreadId)
    if (!parentSelection) return "error: detached spawn_thread caller is no longer active."
    let selection: AgentSelection
    try {
      selection = childSelection(parentSelection, opts.selection)
      assertSelectionAllowed(this.rootId, selection)
    } catch (err) {
      return `error: ${(err as Error).message}`
    }
    const childThreadId = `child-${randomUUID()}`
    const record = createDetachedSpawn(this.rootId, childThreadId, opts.title, false, { kind: "spawn_thread" })
    if (!record) return `error: detached spawn limit reached (${detachedSpawnLimit()} running children in this session). Wait for one to finish or use workflow.`

    // Capture every per-run value now. In particular, do not resolve selection
    // or workspace from the thread registry after the caller's turn disposes.
    const sessionId = this.rootId
    const workspace = this.workspace
    const emit = this.emit
    const agentFor = this.agentFor
    const preflightAgentProvider = this.preflightAgentProvider
    const parentThreadId = opts.callerThreadId === sessionId ? null : opts.callerThreadId
    const delegationId = randomUUID()
    Store.createDelegation({ id: delegationId, sessionId, kind: "child", provider: selection.provider, model: selection.model ?? "unknown", effort: selection.effort ?? undefined, briefSnippet: opts.instructions })
    if (isIncognitoSession(sessionId)) registerIncognitoThread(childThreadId)
    registerThread(childThreadId, this)
    this.selections.set(childThreadId, selection)
    emit({ type: "thread.spawn", threadId: childThreadId, parentThreadId, title: opts.title, model: selection.model })
    emit({ type: "thread.status", threadId: childThreadId, status: "running", title: opts.title })
    void this.runDetachedSpawn({ record, selection, instructions: opts.instructions, delegationId, workspace, emit, agentFor, preflightAgentProvider })
    return `Detached child "${opts.title}" launched: ${record.id}. It runs concurrently; its report will wake you or arrive as a reminder.`
  }

  private async runDetachedSpawn(opts: {
    record: DetachedSpawnRecord
    selection: AgentSelection
    instructions: string
    delegationId: string
    workspace: string
    emit: Emit
    agentFor: AgentForSelection
    preflightAgentProvider: boolean
  }): Promise<void> {
    const { record, selection, instructions, delegationId, workspace, emit, agentFor, preflightAgentProvider } = opts
    let report = ""
    const dog = createDelegateWatchdog({ emit, label: `detached child thread "${record.title}"`, parent: record.abort })
    try {
      if (preflightAgentProvider) await getProvider(selection.provider)?.ensureAuth?.()
      if (providerRuntime(selection.provider) === "anthropic-sdk") {
        const { runAnthropicAgent } = await import("./anthropic-runner.ts")
        report = await runAnthropicAgent({
          selection, threadId: record.childThreadId, prompt: instructions, emit: dog.emit, eventThreadId: record.childThreadId,
          freshSession: true, workspace, repositoryLess: Store.repositoryScopeOf(record.sessionId) === "none", abort: dog.abort,
          usageContext: { sessionId: record.sessionId, role: "child", delegationId },
        })
      } else {
        const stream = await AsyncLocalStorageProviderSingleton.getInstance().run(undefined, () =>
          agentFor(selection, workspace, undefined, record.sessionId).stream(
            { messages: [{ role: "user", content: instructions }] },
            { configurable: { thread_id: record.childThreadId, workspace }, streamMode: ["updates", "messages"], recursionLimit: RECURSION_LIMIT, signal: dog.abort.signal } as any,
          ),
        )
        report = await translateStream(stream, record.childThreadId, dog.emit, undefined, undefined, { sessionId: record.sessionId, selection, role: "child", delegationId })
      }
      report = `${ThreadManager.nonEmptyReport(report, "detached child thread")}\n\n[delegation: ${delegationId}]`
    } catch (err) {
      const cancelled = record.abort.signal.aborted && !dog.timedOut()
      const message = dog.timedOut() ? dog.timeoutMessage() : cancelled
        ? (record.abort.signal.reason instanceof Error ? record.abort.signal.reason.message : String(record.abort.signal.reason ?? "cancelled by user"))
        : ((err as Error)?.message ?? String(err))
      emitDelegateFailure(emit, record.childThreadId, message, cancelled)
      report = cancelled ? message : `error: ${message}`
    } finally {
      dog.dispose()
      finishDetachedSpawn(record, report || "error: detached child thread finished without producing a report")
      completeDelegationFromReport(delegationId, record.result ?? report)
      emit({ type: "thread.status", threadId: record.childThreadId, status: record.status === "cancelled" ? "cancelled" : "idle", title: record.title })
      unregisterThread(record.childThreadId)
      this.selections.delete(record.childThreadId)
      const reminder = `Detached child "${record.title}" (${record.id}) finished. Report:\n${record.result}`
      const shownText = `Detached child "${record.title}" (${record.id}) finished.`
      const wakePrompt = `${reminder}\n\nAssess this detached child report and act on any valid findings before finalizing.`
      if (routeBackgroundNotice(record.sessionId, wakePrompt, shownText, "spawn_thread", { kind: "spawn_thread", detachedSpawnId: record.id }) === "reminder") appendReminder(record.sessionId, reminder)
    }
  }

  /**
   * Run a dynamic-workflow script for `callerThreadId`. The script fans out
   * sub-agents through `agent()`, which is this manager's `spawn()` under the
   * hood — so every workflow agent is a real child thread that streams over the
   * session SSE and renders in the TUI thread-tree, and grandchildren still route
   * correctly. Intermediate results stay in the script's variables; only the final
   * return value comes back to the calling model. The manager supplies the emitter,
   * the concurrency cap, and the small/medium/big → model-selection tier policy.
   */
  async runWorkflow(opts: { callerThreadId: string; script: string; args?: unknown; resumeFromRunId?: string; workflowName?: string }): Promise<string> {
    let routerPromise: ReturnType<typeof workflowRouteResolver> | undefined
    const router = () => (routerPromise ??= workflowRouteResolver())
    const inner: WorkflowHost = {
      runId: opts.resumeFromRunId ?? randomUUID(),
      // Owner tagging mirrors spawn()'s parent linkage: root → undefined (events
      // untagged = main thread); a descendant → its own id so workflow.* lines land
      // in that thread's transcript.
      ownerThreadId: opts.callerThreadId === this.rootId ? undefined : opts.callerThreadId,
      concurrency: workflowConcurrency(),
      emit: this.emit,
      spawn: ({ title, instructions, selection }) =>
        this.spawn({ callerThreadId: opts.callerThreadId, title, instructions, selection, kind: "workflow_agent" }),
      routeOverride: async (request) => {
        const selection = await router().then((r) => r.resolve(request))
        if (selection.provider) assertSelectionAllowed(this.rootId, selection as AgentSelection)
        return selection
      },
      validateExplicit: async (selection) => {
        const validated = await router().then((r) => r.validateExplicit(selection))
        if (validated.provider) assertSelectionAllowed(this.rootId, validated as AgentSelection)
        return validated
      },
      tierOverride: (tier) => {
        const selection = this.tierOverride(tier)
        if (selection?.provider) assertSelectionAllowed(this.rootId, selection as AgentSelection)
        return selection
      },
    }
    let host = inner
    let journaled = false
    let runId = inner.runId
    try {
      const prepared = prepareJournaledHost(inner, {
        script: opts.script,
        args: opts.args,
        resumeFrom: opts.resumeFromRunId,
        incognito: isIncognitoSession(this.rootId),
        workflowName: opts.workflowName,
      })
      host = prepared.host
      journaled = prepared.journaled
      runId = prepared.runId
    } catch (err) {
      if (err instanceof WorkflowJournalError) return annotateWorkflowResult(opts.resumeFromRunId ?? inner.runId, `workflow error: ${err.message}`, true)
      throw err
    }
    const result = await runWorkflowScript(host, opts.script, opts.args)
    return annotateWorkflowResult(runId, result, journaled)
  }

  /**
   * Map a workflow tier to a model-selection override. Lean policy: `big` routes
   * to the configured advisor model (the session's premium model) when one is
   * set, else the active selection — either way with reasoning effort CAPPED at
   * medium ("big" buys a stronger model for judgment calls, not maximum thinking
   * time multiplied across a fan-out). `small` and `medium` anchor to the GLOBAL
   * active selection (the user's /model choice) at low/default effort — anchored
   * rather than inherited so a workflows-mode goal session pinned to a premium
   * orchestrator fans out on the everyday model instead of multiplying the
   * premium one. In an ordinary session the caller IS the active selection, so
   * anchoring changes nothing. Scripts that pass an explicit provider/model/
   * effort on agent() bypass tiers entirely (see engine.ts selectionFor). A
   * fully configurable per-provider tier map + picker is a later increment.
   */
  private tierOverride(tier: WorkflowTier): AgentSelectionOverride | undefined {
    if (tier === "big") {
      const advisor = resolveAdvisorSelection(this.rootId)
      if (advisor) return { provider: advisor.provider, model: advisor.model, effort: capEffortAtMedium(advisor.effort) }
      return { effort: "medium" }
    }
    const base = activeSelection()
    if (tier === "small") return { provider: base.provider, model: base.model, effort: "low" }
    return { provider: base.provider, model: base.model, effort: base.effort }
  }

  /**
   * Consult the always-on advisor and return its guidance. Unlike spawn(), this
   * runs on a STABLE thread id (`${rootId}:advisor`, never randomUUID): the
   * checkpointer keys on thread_id, so each consult resumes the SAME advisor
   * conversation — continuity for free. The advisor thread is deliberately NOT
   * registered in the thread registry, NOT added to `selections`, and NOT
   * disposed after the consult (the advisor has no spawn/advisor tools, so nothing
   * inside it resolves a manager, and its thread must persist for the session).
   */
  async consultAdvisor(opts: {
    callerThreadId: string
    question: string
    pointers?: string
  }): Promise<string> {
    const advisorSel = resolveAdvisorSelection(this.rootId)
    if (!advisorSel) {
      return "error: no advisor is configured — ask the user to set one (/advisor)."
    }
    assertSelectionAllowed(this.rootId, advisorSel)

    // Tally the consult before running it — measures how often the model reaches
    // for the advisor, independent of whether the consult itself succeeds.
    const consultNo = (advisorConsultsBySession.get(this.rootId) ?? 0) + 1
    advisorConsultsBySession.set(this.rootId, consultNo)
    console.log(`[@chunky/server] advisor consult #${consultNo} this session (${this.rootId})`)

    // Fail fast on an expired advisor sign-in — otherwise the consult stream can
    // hang silently (this was the "stuck on the advisor" wedge). run.ts only
    // preflights the ROOT provider's auth, never the advisor's separate provider.
    if (this.preflightAdvisorProvider) {
      try {
        await getProvider(advisorSel.provider)?.ensureAuth?.()
      } catch (err) {
        const detail = (err as Error)?.message ?? String(err)
        return `error: advisor provider "${advisorSel.provider}" sign-in expired — run /login to re-authenticate. (${detail})`
      }
    }

    const advisorThreadId = `${this.rootId}:advisor`
    if (isIncognitoSession(this.rootId)) registerIncognitoThread(this.rootId)
    const content = opts.pointers
      ? `${opts.question}\n\nWhere to look / context:\n${opts.pointers}`
      : opts.question

    this.emit({ type: "thread.spawn", threadId: advisorThreadId, parentThreadId: null, title: "Advisor", model: advisorSel.model })
    this.emit({ type: "thread.status", threadId: advisorThreadId, status: "running", title: "Advisor" })

    let finalText = ""
    const dog = createDelegateWatchdog({ emit: this.emit, label: "advisor", parent: this.abort })
    let resolveLive!: () => void
    const live: LiveDelegateHandle = {
      kind: "advisor",
      sessionId: this.rootId,
      threadId: advisorThreadId,
      title: "Advisor",
      startedAt: Date.now(),
      abort: (reason) => dog.abort.abort(new Error(reason)),
      done: new Promise<void>((resolve) => { resolveLive = resolve }),
    }
    registerLiveDelegate(live)
    try {
      if (providerRuntime(advisorSel.provider) === "anthropic-sdk") {
        // Anthropic advisors (Claude) run via the SDK runtime, not LangChain —
        // with the read-only advisor prompt + only read/bash. The stable
        // advisorThreadId persists/resumes the session for continuity.
        const { runAnthropicAgent } = await import("./anthropic-runner.ts")
        finalText = await runAnthropicAgent({
          selection: advisorSel,
          threadId: advisorThreadId,
          prompt: content,
          emit: dog.emit,
          eventThreadId: advisorThreadId,
          systemPrompt: ADVISOR_SYSTEM_PROMPT,
          allowedTools: ["mcp__chunky__read", "mcp__chunky__bash"],
          workspace: this.workspace,
          abort: dog.abort,
        })
      } else {
        // Same async-local isolation as spawn(): a cleared store so the advisor's
        // tokens stream only through its OWN iterator, tagged with its threadId,
        // instead of leaking (untagged) into the caller's messages stream.
        const stream = await AsyncLocalStorageProviderSingleton.getInstance().run(undefined, () =>
          streamWithCheckpointRecovery(
            this.advisorAgentFor(advisorSel, this.workspace, undefined, this.rootId),
            { messages: [{ role: "user", content }] },
            {
              configurable: { thread_id: advisorThreadId, workspace: this.workspace },
              streamMode: ["updates", "messages"],
              recursionLimit: RECURSION_LIMIT,
              signal: dog.abort.signal,
            } as any,
          ),
        )
        finalText = await translateStream(stream, advisorThreadId, dog.emit, undefined, undefined, { sessionId: this.rootId, selection: advisorSel, role: "advisor" })
      }
    } catch (err) {
      const cancelled = Boolean(dog.abort.signal.aborted) && !dog.timedOut() && !this.abort?.signal.aborted
      const message = dog.timedOut() ? dog.timeoutMessage() : cancelled
        ? (dog.abort.signal.reason instanceof Error ? dog.abort.signal.reason.message : String(dog.abort.signal.reason ?? "cancelled by user"))
        : ((err as Error)?.message ?? String(err))
      emitDelegateFailure(this.emit, advisorThreadId, message, cancelled)
      finalText = cancelled ? message : `error: ${message}`
    } finally {
      dog.dispose()
      unregisterLiveDelegate(live)
      resolveLive()
      this.emit({ type: "thread.status", threadId: advisorThreadId, status: terminalThreadStatus(finalText), title: "Advisor" })
    }

    return ThreadManager.nonEmptyReport(finalText, "advisor")
  }

  /** Launch a fresh, detached reviewer. Unlike advisor/sidekick, review is
   * deliberately stateless and never awaited by the calling tool turn. */
  launchReview(opts: { callerThreadId: string; brief: string; pointers?: string }): string {
    const reviewSel = resolveReviewSelection(this.rootId)
    if (!reviewSel) return "error: no reviewer is configured — ask the user to configure one."
    try { assertSelectionAllowed(this.rootId, reviewSel) } catch (err) { return `error: ${(err as Error).message}` }

    const reviewId = randomUUID()
    const reviewThreadId = `${this.rootId}:review:${reviewId}`
    const delegationId = randomUUID()
    Store.createDelegation({ id: delegationId, sessionId: this.rootId, kind: "review", provider: reviewSel.provider, model: reviewSel.model ?? "unknown", effort: reviewSel.effort ?? undefined, briefSnippet: opts.brief })
    this.emit({ type: "thread.spawn", threadId: reviewThreadId, parentThreadId: opts.callerThreadId === this.rootId ? null : opts.callerThreadId, title: "Review", model: reviewSel.model })
    this.emit({ type: "thread.status", threadId: reviewThreadId, status: "running", title: "Review" })

    void this.runReview({ reviewId, reviewThreadId, delegationId, selection: reviewSel, brief: opts.brief, pointers: opts.pointers })
    return `review launched: ${reviewId}. Continue verification; findings will arrive as a session reminder.`
  }

  private async runReview(opts: { reviewId: string; reviewThreadId: string; delegationId: string; selection: AgentSelection; brief: string; pointers?: string }): Promise<void> {
    const { reviewId, reviewThreadId, delegationId, selection, brief, pointers } = opts
    const content = pointers ? `Review this completed change.\n\nBrief:\n${brief}\n\nFocus / pointers:\n${pointers}` : `Review this completed change.\n\nBrief:\n${brief}`
    let report = ""
    let ok = false
    const dog = createDelegateWatchdog({ emit: this.emit, label: "review", parent: this.abort })
    try {
      if (this.preflightReviewProvider) await getProvider(selection.provider)?.ensureAuth?.()
      if (providerRuntime(selection.provider) === "anthropic-sdk") {
        const { runAnthropicAgent } = await import("./anthropic-runner.ts")
        report = await runAnthropicAgent({
          selection, threadId: reviewThreadId, prompt: content, emit: dog.emit, eventThreadId: reviewThreadId,
          freshSession: true, systemPrompt: REVIEW_SYSTEM_PROMPT,
          allowedTools: ["mcp__chunky__read", "mcp__chunky__bash", "mcp__chunky__fffind", "mcp__chunky__ffgrep"],
          workspace: this.workspace, abort: dog.abort,
          usageContext: { sessionId: this.rootId, role: "review", delegationId },
        })
      } else {
        const stream = await AsyncLocalStorageProviderSingleton.getInstance().run(undefined, () =>
          streamWithCheckpointRecovery(this.reviewAgentFor(selection, this.workspace, undefined, this.rootId),
            { messages: [{ role: "user", content }] },
            { configurable: { thread_id: reviewThreadId, workspace: this.workspace }, streamMode: ["updates", "messages"], recursionLimit: RECURSION_LIMIT, signal: dog.abort.signal } as any),
        )
        report = await translateStream(stream, reviewThreadId, dog.emit, undefined, undefined, { sessionId: this.rootId, selection, role: "review", delegationId })
      }
      report = ThreadManager.nonEmptyReport(report, "reviewer")
      ok = !report.startsWith("error:")
    } catch (err) {
      const message = dog.timedOut() ? dog.timeoutMessage() : ((err as Error)?.message ?? String(err))
      this.emit({ type: "error", message, threadId: reviewThreadId } as AgentEvent)
      report = `error: ${message}`
    } finally {
      dog.dispose()
      Store.completeDelegation(delegationId, ok)
      this.emit({ type: "thread.status", threadId: reviewThreadId, status: "idle", title: "Review" })
      const reminder = `Review ${reviewId} finished. Findings:\n${report}`
      // Reviews outlive the initiating turn, but the process-global dispatcher
      // owns the session runner and remains available after this manager is
      // disposed. Wake an idle lead with the complete actionable report; queue
      // the established reminder unchanged while it is busy.
      const wakePrompt = `${reminder}\n\nAssess these review findings and fix any valid issues before finalizing.`
      if (routeBackgroundNotice(this.rootId, wakePrompt, "Review finished; assess the findings before finalizing.", "review") === "reminder") {
        appendReminder(this.rootId, reminder)
      }
    }
  }

  /**
   * Hand a brief to the sidekick and return its report. Like consultAdvisor,
   * this runs on a STABLE thread id (`${rootId}:sidekick`, never randomUUID):
   * the checkpointer keys on thread_id, so each handoff resumes the SAME worker
   * conversation — the sidekick keeps the repo context it built during earlier
   * briefs, which is what makes follow-up handoffs ("fix the bug in the diff
   * you just wrote") cheap. A NAMED seat (e.g. "frontend") gets its own stable
   * id (`${rootId}:sidekick:frontend`), so each domain seat accumulates its own
   * context. The sidekick thread is deliberately NOT registered in the thread
   * registry and NOT in `selections` (it has no delegation tools, so nothing
   * inside it resolves a manager), and persists for the session.
   */
  async delegateToSidekick(opts: { callerThreadId: string; brief: string; seat?: string; briefStruct?: EvalBriefStruct }): Promise<string> {
    const seat = opts.seat?.trim() || "default"
    const key = `${this.rootId}\0${seat}`
    const previous = sidekickSeatTails.get(key) ?? Promise.resolve()
    let release!: () => void
    const tail = new Promise<void>((resolve) => { release = resolve })
    sidekickSeatTails.set(key, tail)
    await previous
    try {
      return await this.runSidekick(opts)
    } finally {
      release()
      if (sidekickSeatTails.get(key) === tail) sidekickSeatTails.delete(key)
    }
  }

  private async runSidekick(opts: { callerThreadId: string; brief: string; seat?: string; briefStruct?: EvalBriefStruct }): Promise<string> {
    const rootSelection = this.selections.get(this.rootId) ?? activeSelection()
    const seat = opts.seat?.trim() || undefined
    const sidekickSel = seat && seat !== "default" ? resolveSidekickSeat(seat, this.rootId) : sidekickFor(rootSelection, this.rootId)
    if (!sidekickSel) {
      if (seat && seat !== "default") {
        // Guard the seat name like spawn_thread guards providers: error with the
        // valid set so the lead corrects itself instead of the handoff dying.
        const seats = listSidekickSeats(this.rootId)
        return seats.length > 0
          ? `error: unknown sidekick seat "${seat}". Configured seats: ${seats.map((s) => `"${s}"`).join(", ")} (or omit "seat" for the default). Ask the user to add seats with /sidekick <name>.`
          : `error: no named sidekick seats are configured — omit "seat" to use the default sidekick, or ask the user to add one with /sidekick <name>.`
      }
      return "error: the sidekick is disabled — ask the user to enable it (/sidekick)."
    }
    assertSelectionAllowed(this.rootId, sidekickSel)
    const delegationId = randomUUID()
    Store.createDelegation({ id: delegationId, sessionId: this.rootId, kind: "sidekick", seat, provider: sidekickSel.provider, model: sidekickSel.model ?? "unknown", effort: sidekickSel.effort ?? undefined, briefSnippet: opts.brief })

    const isNamedSeat = seat !== undefined && seat !== "default"
    const sidekickThreadId = isNamedSeat ? `${this.rootId}:sidekick:${seat}` : `${this.rootId}:sidekick`
    recordSidekickStart({
      delegationId,
      sessionId: this.rootId,
      seat,
      sidekickThreadId,
      provider: sidekickSel.provider,
      model: sidekickSel.model ?? "unknown",
      effort: sidekickSel.effort ?? undefined,
      workspace: this.workspace,
      briefStruct: opts.briefStruct,
      briefComposed: opts.brief,
    })

    // Tally the handoff before running it — measures how often the lead
    // delegates, independent of whether the handoff itself succeeds.
    const handoffNo = (sidekickHandoffsBySession.get(this.rootId) ?? 0) + 1
    sidekickHandoffsBySession.set(this.rootId, handoffNo)
    console.log(`[@chunky/server] sidekick handoff #${handoffNo} this session (${this.rootId})`)

    // Fail fast on an expired sidekick sign-in — mirrors the advisor preflight;
    // run.ts only preflights the ROOT provider's auth, never the sidekick's
    // separate provider.
    if (this.preflightSidekickProvider) {
      try {
        await getProvider(sidekickSel.provider)?.ensureAuth?.()
      } catch (err) {
        const detail = (err as Error)?.message ?? String(err)
        const message = `error: sidekick provider "${sidekickSel.provider}" sign-in expired — run /login to re-authenticate. (${detail})`
        recordSidekickComplete({
          delegationId,
          sessionId: this.rootId,
          sidekickThreadId,
          ok: false,
          finalReport: message,
        })
        return message
      }
    }

    if (isIncognitoSession(this.rootId)) registerIncognitoThread(this.rootId)
    const title = isNamedSeat ? `Sidekick (${seat})` : "Sidekick"
    const sidekickKey = isNamedSeat ? seat! : "default"
    let sessionSidekicks = activeSidekicks.get(this.rootId)
    if (!sessionSidekicks) { sessionSidekicks = new Map(); activeSidekicks.set(this.rootId, sessionSidekicks) }
    sessionSidekicks.set(sidekickKey, { seat: sidekickKey, brief: opts.brief })
    notifySessionChanged(this.rootId)

    this.emit({ type: "thread.spawn", threadId: sidekickThreadId, parentThreadId: null, title, model: sidekickSel.model })
    this.emit({ type: "thread.status", threadId: sidekickThreadId, status: "running", title })

    let finalText = ""
    let dog = createDelegateWatchdog({ emit: this.emit, label: "sidekick", parent: this.abort })
    let resolveLive!: () => void
    const live: LiveDelegateHandle = {
      kind: "sidekick",
      sessionId: this.rootId,
      threadId: sidekickThreadId,
      seat: sidekickKey,
      title,
      startedAt: Date.now(),
      abort: (reason) => dog.abort.abort(new Error(reason)),
      done: new Promise<void>((resolve) => { resolveLive = resolve }),
    }
    registerLiveDelegate(live)
    try {
      const agentsMd = await distilledAgentsMd(this.workspace, rootSelection, this.rootId)
      const repoMemory = readRepoMemory(this.workspace, this.rootId)
      const runOnce = async (prompt: string): Promise<string> => {
        if (providerRuntime(sidekickSel.provider) === "anthropic-sdk") {
          // Anthropic sidekicks run via the SDK runtime with the worker prompt +
          // the hands-on toolset (read/bash/search/write/edit — no delegation
          // tools). The stable sidekickThreadId persists/resumes the session.
          const { runAnthropicAgent } = await import("./anthropic-runner.ts")
          return await runAnthropicAgent({
            selection: sidekickSel,
            threadId: sidekickThreadId,
            prompt,
            emit: dog.emit,
            eventThreadId: sidekickThreadId,
            systemPrompt: sidekickSystemPrompt(agentsMd, "standard", repoMemory),
            allowedTools: [
              "mcp__chunky__read",
              "mcp__chunky__bash",
              "mcp__chunky__fffind",
              "mcp__chunky__ffgrep",
              "mcp__chunky__write",
              "mcp__chunky__edit",
            ],
            workspace: this.workspace,
            agentsMd,
            abort: dog.abort,
            usageContext: { sessionId: this.rootId, role: "sidekick", delegationId },
          })
        }
        // Same async-local isolation as spawn(): a cleared store so the sidekick's
        // tokens stream only through its OWN iterator, tagged with its threadId.
        const stream = await AsyncLocalStorageProviderSingleton.getInstance().run(undefined, () =>
          streamWithCheckpointRecovery(
            this.sidekickAgentFor(sidekickSel, this.workspace, agentsMd, this.rootId, repoMemory),
            { messages: [{ role: "user", content: prompt }] },
            {
              configurable: { thread_id: sidekickThreadId, workspace: this.workspace },
              streamMode: ["updates", "messages"],
              recursionLimit: RECURSION_LIMIT,
              signal: dog.abort.signal,
            } as any,
          ),
        )
        return await translateStream(stream, sidekickThreadId, dog.emit, undefined, undefined, { sessionId: this.rootId, selection: sidekickSel, role: "sidekick", delegationId })
      }

      try {
        finalText = await runOnce(opts.brief)
      } catch (err) {
        const userAborted = Boolean(this.abort?.signal.aborted)
        const cancelled = !userAborted && dog.abort.signal.aborted && !dog.timedOut()
        const message = dog.timedOut() ? dog.timeoutMessage() : cancelled
          ? (dog.abort.signal.reason instanceof Error ? dog.abort.signal.reason.message : String(dog.abort.signal.reason ?? "cancelled by user"))
          : ((err as Error)?.message ?? String(err))
        if (!shouldRetryDelegate({
          attempt: 0,
          transient: isTransientDelegateFailure(err, dog, { userAborted }),
          userAborted,
        })) {
          emitDelegateFailure(this.emit, sidekickThreadId, message, cancelled)
          finalText = cancelled ? message : `error: ${message}`
        } else {
          this.emit({
            type: "error",
            message: `transport failure (${transientFailureReason(err, dog)}) — retrying once`,
            threadId: sidekickThreadId,
          } as AgentEvent)
          dog.dispose()
          dog = createDelegateWatchdog({ emit: this.emit, label: "sidekick", parent: this.abort })
          live.abort = (reason) => dog.abort.abort(new Error(reason))
          try {
            finalText = await runOnce(DELEGATE_TRANSPORT_RETRY_PROMPT)
          } catch (retryErr) {
            const retryMessage = dog.timedOut() ? dog.timeoutMessage() : ((retryErr as Error)?.message ?? String(retryErr))
            this.emit({ type: "error", message: retryMessage, threadId: sidekickThreadId } as AgentEvent)
            finalText = `error (after 1 retry): ${retryMessage}`
          }
        }
      }
    } finally {
      const cancelled = isCancelledReason(finalText)
      const ok = reportIsOk(finalText)
      completeDelegationFromReport(delegationId, finalText)
      if (cancelled) discardSidekickCandidate(delegationId)
      else recordSidekickComplete({
        delegationId,
        sessionId: this.rootId,
        sidekickThreadId,
        ok,
        finalReport: ThreadManager.nonEmptyReport(finalText, "sidekick"),
      })
      dog.dispose()
      rememberTerminalSidekick(this.rootId, sidekickKey, sidekickThreadId, cancelled ? "cancelled" : ok ? "completed" : "failed")
      unregisterLiveDelegate(live)
      resolveLive()
      this.emit({ type: "thread.status", threadId: sidekickThreadId, status: terminalThreadStatus(finalText), title })
      sessionSidekicks.delete(sidekickKey)
      if (sessionSidekicks.size === 0) activeSidekicks.delete(this.rootId)
      notifySessionChanged(this.rootId)
    }

    return isCancelledReason(finalText)
      ? finalText
      : `${ThreadManager.nonEmptyReport(finalText, "sidekick")}\n\n[delegation: ${delegationId}]`
  }
}
