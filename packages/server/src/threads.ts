// Real nested threads. A ThreadManager turns a `spawn_thread` request into a
// FULL, independent agent turn: it mints a childThreadId, runs `agent.stream`
// on its OWN LangGraph `thread_id = childThreadId` (its own checkpointer entry),
// pipes that stream through the shared `translateStream` tagged with the child's
// id, and brackets it with `thread.spawn` + `thread.status running/idle`. Because
// each spawn is a real independent agent run whose model also has `spawn_thread`,
// children can spawn children (recursion). All events flow over the existing
// session SSE — no new routes.
import { randomUUID } from "node:crypto"
import { AsyncLocalStorageProviderSingleton } from "@langchain/core/singletons"
import type { AgentEvent } from "@chunky/protocol"
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
import { registerIncognitoThread } from "./bun-sqlite-saver.ts"
import { runWorkflowScript, workflowConcurrency, type WorkflowHost, type WorkflowTier } from "./workflow/engine.ts"
import { workflowRouteResolver } from "./workflow/router.ts"
import { streamWithCheckpointRecovery } from "./checkpoint-recovery.ts"
import { createDelegateWatchdog } from "./watchdog.ts"
import { Store } from "./store.ts"
import { appendReminder } from "./tasks.ts"
import { routeBackgroundNotice } from "./background-dispatch.ts"

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
  private readonly runningChildren = new Map<string, { threadId: string; title: string }>()

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
    unregisterThread(this.rootId)
    this.selections.clear()
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

  async spawn(opts: {
    callerThreadId: string
    title: string
    instructions: string
    selection?: AgentSelectionOverride
    kind?: "child" | "workflow_agent"
  }): Promise<string> {
    const childThreadId = randomUUID()
    if (isIncognitoSession(this.rootId)) registerIncognitoThread(childThreadId)
    const parentThreadId = opts.callerThreadId === this.rootId ? null : opts.callerThreadId
    const parentSelection = this.selections.get(opts.callerThreadId)
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

    // Inactivity watchdog: if the child's stream goes silent (stalled provider
    // connection), abort it and hand the lead a real error instead of hanging
    // the awaited tool promise forever. Every event the child emits resets it.
    const dog = createDelegateWatchdog({ emit: this.emit, label: `child thread "${opts.title}"`, parent: this.abort })
    try {
      if (providerRuntime(selection.provider) === "anthropic-sdk") {
        const { runAnthropicAgent } = await import("./anthropic-runner.ts")
        return ThreadManager.nonEmptyReport(
          await runAnthropicAgent({
            selection,
            threadId: childThreadId,
            prompt: opts.instructions,
            emit: dog.emit,
            eventThreadId: childThreadId,
            freshSession: true,
            workspace: this.workspace,
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
      const stream = await AsyncLocalStorageProviderSingleton.getInstance().run(undefined, () =>
        this.agentFor(selection, this.workspace, undefined, this.rootId).stream(
          { messages: [{ role: "user", content: opts.instructions }] },
          {
            configurable: { thread_id: childThreadId, workspace: this.workspace },
            streamMode: ["updates", "messages"],
            recursionLimit: RECURSION_LIMIT,
            signal: dog.abort.signal,
          } as any,
        ),
      )
      return `${ThreadManager.nonEmptyReport(await translateStream(stream, childThreadId, dog.emit, undefined, undefined, { sessionId: this.rootId, selection, role: "child", delegationId }), "child thread")}\n\n[delegation: ${delegationId}]`
    } catch (err) {
      const message = dog.timedOut() ? dog.timeoutMessage() : ((err as Error)?.message ?? String(err))
      this.emit({ type: "error", message, threadId: childThreadId } as AgentEvent)
      return `error: ${message}`
    } finally {
      Store.completeDelegation(delegationId, true)
      dog.dispose()
      this.emit({ type: "thread.status", threadId: childThreadId, status: "idle", title: opts.title })
      unregisterThread(childThreadId)
      this.selections.delete(childThreadId)
      this.runningChildren.delete(childThreadId)
      const sessionChildren = runningChildrenBySession.get(this.rootId)
      sessionChildren?.delete(childThreadId)
      if (sessionChildren?.size === 0) runningChildrenBySession.delete(this.rootId)
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
  async runWorkflow(opts: { callerThreadId: string; script: string; args?: unknown }): Promise<string> {
    let routerPromise: ReturnType<typeof workflowRouteResolver> | undefined
    const router = () => (routerPromise ??= workflowRouteResolver())
    const host: WorkflowHost = {
      runId: randomUUID(),
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
    return runWorkflowScript(host, opts.script, opts.args)
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
      const advisor = resolveAdvisorSelection()
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
    const advisorSel = resolveAdvisorSelection()
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
      const message = dog.timedOut() ? dog.timeoutMessage() : ((err as Error)?.message ?? String(err))
      this.emit({ type: "error", message, threadId: advisorThreadId } as AgentEvent)
      finalText = `error: ${message}`
    } finally {
      dog.dispose()
      this.emit({ type: "thread.status", threadId: advisorThreadId, status: "idle", title: "Advisor" })
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
  async delegateToSidekick(opts: { callerThreadId: string; brief: string; seat?: string }): Promise<string> {
    const rootSelection = this.selections.get(this.rootId) ?? activeSelection()
    const seat = opts.seat?.trim() || undefined
    const sidekickSel = seat && seat !== "default" ? resolveSidekickSeat(seat) : sidekickFor(rootSelection)
    if (!sidekickSel) {
      if (seat && seat !== "default") {
        // Guard the seat name like spawn_thread guards providers: error with the
        // valid set so the lead corrects itself instead of the handoff dying.
        const seats = listSidekickSeats()
        return seats.length > 0
          ? `error: unknown sidekick seat "${seat}". Configured seats: ${seats.map((s) => `"${s}"`).join(", ")} (or omit "seat" for the default). Ask the user to add seats with /sidekick <name>.`
          : `error: no named sidekick seats are configured — omit "seat" to use the default sidekick, or ask the user to add one with /sidekick <name>.`
      }
      return "error: the sidekick is disabled — ask the user to enable it (/sidekick)."
    }
    assertSelectionAllowed(this.rootId, sidekickSel)
    const delegationId = randomUUID()
    Store.createDelegation({ id: delegationId, sessionId: this.rootId, kind: "sidekick", seat, provider: sidekickSel.provider, model: sidekickSel.model ?? "unknown", effort: sidekickSel.effort ?? undefined, briefSnippet: opts.brief })

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
        return `error: sidekick provider "${sidekickSel.provider}" sign-in expired — run /login to re-authenticate. (${detail})`
      }
    }

    const isNamedSeat = seat !== undefined && seat !== "default"
    const sidekickThreadId = isNamedSeat ? `${this.rootId}:sidekick:${seat}` : `${this.rootId}:sidekick`
    if (isIncognitoSession(this.rootId)) registerIncognitoThread(this.rootId)
    const title = isNamedSeat ? `Sidekick (${seat})` : "Sidekick"
    const sidekickKey = isNamedSeat ? seat! : "default"
    let sessionSidekicks = activeSidekicks.get(this.rootId)
    if (!sessionSidekicks) { sessionSidekicks = new Map(); activeSidekicks.set(this.rootId, sessionSidekicks) }
    sessionSidekicks.set(sidekickKey, { seat: sidekickKey, brief: opts.brief })

    this.emit({ type: "thread.spawn", threadId: sidekickThreadId, parentThreadId: null, title, model: sidekickSel.model })
    this.emit({ type: "thread.status", threadId: sidekickThreadId, status: "running", title })

    let finalText = ""
    const dog = createDelegateWatchdog({ emit: this.emit, label: "sidekick", parent: this.abort })
    try {
      const agentsMd = await distilledAgentsMd(this.workspace, rootSelection, this.rootId)
      const repoMemory = readRepoMemory(this.workspace, this.rootId)
      if (providerRuntime(sidekickSel.provider) === "anthropic-sdk") {
        // Anthropic sidekicks run via the SDK runtime with the worker prompt +
        // the hands-on toolset (read/bash/search/write/edit — no delegation
        // tools). The stable sidekickThreadId persists/resumes the session.
        const { runAnthropicAgent } = await import("./anthropic-runner.ts")
        finalText = await runAnthropicAgent({
          selection: sidekickSel,
          threadId: sidekickThreadId,
          prompt: opts.brief,
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
      } else {
        // Same async-local isolation as spawn(): a cleared store so the sidekick's
        // tokens stream only through its OWN iterator, tagged with its threadId.
        const stream = await AsyncLocalStorageProviderSingleton.getInstance().run(undefined, () =>
          streamWithCheckpointRecovery(
            this.sidekickAgentFor(sidekickSel, this.workspace, agentsMd, this.rootId, repoMemory),
            { messages: [{ role: "user", content: opts.brief }] },
            {
              configurable: { thread_id: sidekickThreadId, workspace: this.workspace },
              streamMode: ["updates", "messages"],
              recursionLimit: RECURSION_LIMIT,
              signal: dog.abort.signal,
            } as any,
          ),
        )
        finalText = await translateStream(stream, sidekickThreadId, dog.emit, undefined, undefined, { sessionId: this.rootId, selection: sidekickSel, role: "sidekick", delegationId })
      }
    } catch (err) {
      const message = dog.timedOut() ? dog.timeoutMessage() : ((err as Error)?.message ?? String(err))
      this.emit({ type: "error", message, threadId: sidekickThreadId } as AgentEvent)
      finalText = `error: ${message}`
    } finally {
      Store.completeDelegation(delegationId, !finalText.startsWith("error:"))
      dog.dispose()
      this.emit({ type: "thread.status", threadId: sidekickThreadId, status: "idle", title })
      sessionSidekicks.delete(sidekickKey)
      if (sessionSidekicks.size === 0) activeSidekicks.delete(this.rootId)
    }

    return `${ThreadManager.nonEmptyReport(finalText, "sidekick")}\n\n[delegation: ${delegationId}]`
  }
}
