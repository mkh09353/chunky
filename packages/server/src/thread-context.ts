// A tiny per-run registry that lets the `spawn_thread` tool (bound once at agent
// build time) find the ThreadManager for the run it is executing inside.
//
// Custom LangChain tools receive the RunnableConfig as their 2nd argument, whose
// `configurable.thread_id` is the id of the thread whose model invoked the tool.
// We key managers by every live thread_id (root session + each spawned child) so
// a tool call from ANY depth resolves to the right manager — which is how a child
// thread can itself spawn further children (recursion).
//
// This module imports nothing internal, so it breaks what would otherwise be an
// agent.ts <-> threads.ts import cycle.

export interface ThreadSpawner {
  /**
   * Launch a child thread from `callerThreadId` and return its final text.
   * The manager decides the child's threadId and parent linkage.
   */
  spawn(opts: { callerThreadId: string; title: string; instructions: string }): Promise<string>
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
