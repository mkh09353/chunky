// A tiny per-run registry that lets the `spawn_thread` tool (bound once at agent
// build time) find the ThreadManager for the run it is executing inside.
//
// Custom LangChain tools receive the RunnableConfig as their 2nd argument, whose
// `configurable.thread_id` is the id of the thread whose model invoked the tool.
// We key managers by every live thread_id (root session + each spawned child) so
// a tool call from ANY depth resolves to the right manager — which is how a child
// thread can itself spawn further children (recursion).
//
// Its only internal import is type-only, so it remains a runtime-cycle break
// between agent.ts and threads.ts.
import type { AgentSelectionOverride } from "./providers/registry.ts"

export interface ThreadSpawner {
  /**
   * The root session id this manager belongs to. Every live thread_id (root +
   * each spawned child) resolves to the same manager, so a tool invoked at ANY
   * depth can find the session it's running under — which is how the session-
   * scoped goal tools reach the right goal from inside a child thread.
   */
  readonly sessionId: string

  /**
   * Launch a child thread from `callerThreadId` and return its final text.
   * The manager decides the child's threadId and parent linkage.
   */
  spawn(opts: {
    callerThreadId: string
    title: string
    instructions: string
    selection?: AgentSelectionOverride
  }): Promise<string>

  /**
   * Consult the always-on advisor — a persistent side thread on a stronger model
   * (stable thread_id, so it remembers earlier consults this session). Returns
   * the advisor's guidance text.
   */
  consultAdvisor(opts: {
    callerThreadId: string
    question: string
    pointers?: string
  }): Promise<string>

  /**
   * Hand a brief to the sidekick — a persistent worker side thread on a cheaper
   * model (stable thread_id, so it keeps the repo context it built across
   * handoffs this session; follow-up briefs can be short). Returns the
   * sidekick's report.
   */
  delegateToSidekick(opts: {
    callerThreadId: string
    brief: string
  }): Promise<string>

  /**
   * Run a dynamic-workflow `script` on behalf of `callerThreadId`: a JS
   * orchestration that fans out many sub-agents (each a real child thread) via the
   * same `spawn` machinery, and returns one synthesized string. The manager owns
   * the event emitter and the concurrency/model-tier policy the script runs under.
   */
  runWorkflow(opts: {
    callerThreadId: string
    script: string
    args?: unknown
  }): Promise<string>
}

const registry = new Map<string, ThreadSpawner>()

export function registerThread(threadId: string, spawner: ThreadSpawner): void {
  registry.set(threadId, spawner)
}

export function unregisterThread(threadId: string): void {
  registry.delete(threadId)
}

/** Resolve the manager owning `threadId`, or undefined if there is no active run. */
export function threadContextFor(threadId: string | undefined): ThreadSpawner | undefined {
  return threadId ? registry.get(threadId) : undefined
}

/** The root session id owning `threadId`, or undefined if there's no active run.
 *  Lets a session-scoped tool (e.g. goal) map any thread depth back to its
 *  session without knowing anything about the ThreadManager. */
export function sessionForThread(threadId: string | undefined): string | undefined {
  return threadContextFor(threadId)?.sessionId
}
