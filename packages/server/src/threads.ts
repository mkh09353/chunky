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
import { getAdvisorAgent, getAgent, RECURSION_LIMIT } from "./agent.ts"
import { ADVISOR_SYSTEM_PROMPT } from "./prompt.ts"
import {
  activeSelection,
  childSelection,
  providerRuntime,
  resolveAdvisorSelection,
  type AgentSelection,
  type AgentSelectionOverride,
} from "./providers/registry.ts"
import { registerThread, unregisterThread, type ThreadSpawner } from "./thread-context.ts"
import { LAUNCH_WORKSPACE } from "./workspace.ts"
import { runWorkflowScript, workflowConcurrency, type WorkflowHost, type WorkflowTier } from "./workflow/engine.ts"

/** The narrow part of a compiled agent that ThreadManager needs. Keeping this
 * structural lets the deterministic thread test inject a fake stream without
 * model credentials. */
export interface StreamableAgent {
  stream(...args: any[]): Promise<AsyncIterable<unknown>>
}

export type AgentForSelection = (selection: AgentSelection, workspace: string) => StreamableAgent

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

export class ThreadManager implements ThreadSpawner {
  private readonly rootId: string
  private readonly emit: Emit
  /** The root session id (ThreadSpawner contract) — every child resolves here. */
  get sessionId(): string {
    return this.rootId
  }
  private readonly agentFor: AgentForSelection
  private readonly advisorAgentFor: AgentForSelection
  private readonly selections = new Map<string, AgentSelection>()
  /** The session's workspace: every child thread and advisor consult runs here —
   *  a child can never escape into another repo's folder. */
  readonly workspace: string

  constructor(
    emit: Emit,
    rootId: string,
    rootSelection: AgentSelection = activeSelection(),
    agentFor: AgentForSelection = getAgent,
    advisorAgentFor: AgentForSelection = getAdvisorAgent,
    workspace: string = LAUNCH_WORKSPACE,
  ) {
    this.emit = emit
    this.rootId = rootId
    this.agentFor = agentFor
    this.advisorAgentFor = advisorAgentFor
    this.workspace = workspace
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
  async spawn(opts: {
    callerThreadId: string
    title: string
    instructions: string
    selection?: AgentSelectionOverride
  }): Promise<string> {
    const childThreadId = randomUUID()
    const parentThreadId = opts.callerThreadId === this.rootId ? null : opts.callerThreadId
    const parentSelection = this.selections.get(opts.callerThreadId)
    if (!parentSelection) {
      throw new Error(`missing model selection for caller thread ${opts.callerThreadId}`)
    }
    const selection = childSelection(parentSelection, opts.selection)

    // The child is itself a valid spawn context, so grandchildren route correctly.
    registerThread(childThreadId, this)
    this.selections.set(childThreadId, selection)

    this.emit({ type: "thread.spawn", threadId: childThreadId, parentThreadId, title: opts.title })
    this.emit({ type: "thread.status", threadId: childThreadId, status: "running", title: opts.title })

    try {
      if (providerRuntime(selection.provider) === "anthropic-sdk") {
        const { runAnthropicAgent } = await import("./anthropic-runner.ts")
        return await runAnthropicAgent({
          selection,
          threadId: childThreadId,
          prompt: opts.instructions,
          emit: this.emit,
          eventThreadId: childThreadId,
          freshSession: true,
          workspace: this.workspace,
        })
      }

      // A child spawned from inside the parent's tool node runs on the parent's
      // ambient callback context, which would leak the child's LLM tokens into
      // the PARENT's `messages` stream (duplicated, untagged). Create the child
      // stream with a cleared async-local store so it is fully isolated: the
      // child streams only through its OWN iterator, tagged with its threadId.
      const stream = await AsyncLocalStorageProviderSingleton.getInstance().run(undefined, () =>
        this.agentFor(selection, this.workspace).stream(
          { messages: [{ role: "user", content: opts.instructions }] },
          {
            configurable: { thread_id: childThreadId, workspace: this.workspace },
            streamMode: ["updates", "messages"],
            recursionLimit: RECURSION_LIMIT,
          } as any,
        ),
      )
      return await translateStream(stream, childThreadId, this.emit)
    } catch (err) {
      const message = (err as Error)?.message ?? String(err)
      this.emit({ type: "error", message, threadId: childThreadId } as AgentEvent)
      return `error: ${message}`
    } finally {
      this.emit({ type: "thread.status", threadId: childThreadId, status: "idle", title: opts.title })
      unregisterThread(childThreadId)
      this.selections.delete(childThreadId)
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
    const host: WorkflowHost = {
      runId: randomUUID(),
      // Owner tagging mirrors spawn()'s parent linkage: root → undefined (events
      // untagged = main thread); a descendant → its own id so workflow.* lines land
      // in that thread's transcript.
      ownerThreadId: opts.callerThreadId === this.rootId ? undefined : opts.callerThreadId,
      concurrency: workflowConcurrency(),
      emit: this.emit,
      spawn: ({ title, instructions, selection }) =>
        this.spawn({ callerThreadId: opts.callerThreadId, title, instructions, selection }),
      tierOverride: (tier) => this.tierOverride(tier),
    }
    return runWorkflowScript(host, opts.script, opts.args)
  }

  /**
   * Map a workflow tier to a model-selection override. Lean policy: `big` routes
   * to the configured advisor model (the session's premium model) when one is
   * set, else just raises effort; `small` and `medium` anchor to the GLOBAL
   * active selection (the user's /model choice) at low/default effort — anchored
   * rather than inherited so a workflows-mode goal session pinned to a premium
   * orchestrator fans out on the everyday model instead of multiplying the
   * premium one. In an ordinary session the caller IS the active selection, so
   * anchoring changes nothing. A fully configurable per-provider tier map +
   * picker is a later increment.
   */
  private tierOverride(tier: WorkflowTier): AgentSelectionOverride | undefined {
    if (tier === "big") {
      const advisor = resolveAdvisorSelection()
      if (advisor) return { provider: advisor.provider, model: advisor.model, effort: advisor.effort }
      return { effort: "high" }
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

    // Tally the consult before running it — measures how often the model reaches
    // for the advisor, independent of whether the consult itself succeeds.
    const consultNo = (advisorConsultsBySession.get(this.rootId) ?? 0) + 1
    advisorConsultsBySession.set(this.rootId, consultNo)
    console.log(`[@chunky/server] advisor consult #${consultNo} this session (${this.rootId})`)

    const advisorThreadId = `${this.rootId}:advisor`
    const content = opts.pointers
      ? `${opts.question}\n\nWhere to look / context:\n${opts.pointers}`
      : opts.question

    this.emit({ type: "thread.spawn", threadId: advisorThreadId, parentThreadId: null, title: "Advisor" })
    this.emit({ type: "thread.status", threadId: advisorThreadId, status: "running", title: "Advisor" })

    let finalText = ""
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
          emit: this.emit,
          eventThreadId: advisorThreadId,
          systemPrompt: ADVISOR_SYSTEM_PROMPT,
          allowedTools: ["mcp__chunky__read", "mcp__chunky__bash"],
          workspace: this.workspace,
        })
      } else {
        // Same async-local isolation as spawn(): a cleared store so the advisor's
        // tokens stream only through its OWN iterator, tagged with its threadId,
        // instead of leaking (untagged) into the caller's messages stream.
        const stream = await AsyncLocalStorageProviderSingleton.getInstance().run(undefined, () =>
          this.advisorAgentFor(advisorSel, this.workspace).stream(
            { messages: [{ role: "user", content }] },
            {
              configurable: { thread_id: advisorThreadId, workspace: this.workspace },
              streamMode: ["updates", "messages"],
              recursionLimit: RECURSION_LIMIT,
            } as any,
          ),
        )
        finalText = await translateStream(stream, advisorThreadId, this.emit)
      }
    } catch (err) {
      const message = (err as Error)?.message ?? String(err)
      this.emit({ type: "error", message, threadId: advisorThreadId } as AgentEvent)
      finalText = `error: ${message}`
    } finally {
      this.emit({ type: "thread.status", threadId: advisorThreadId, status: "idle", title: "Advisor" })
    }

    return finalText
  }
}
