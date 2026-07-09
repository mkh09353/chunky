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
import type { AgentEvent } from "@mc/protocol"
import { translateStream, type Emit } from "./run.ts"
import { getAgent } from "./agent.ts"
import { registerThread, unregisterThread, type ThreadSpawner } from "./thread-context.ts"

export class ThreadManager implements ThreadSpawner {
  private readonly rootId: string
  private readonly emit: Emit

  constructor(emit: Emit, rootId: string) {
    this.emit = emit
    this.rootId = rootId
    // The root (main session) thread resolves to this manager, so the main
    // model's spawn_thread calls are routed here.
    registerThread(rootId, this)
  }

  /** Release the root registration when the session turn ends. */
  dispose(): void {
    unregisterThread(this.rootId)
  }

  /**
   * Run a full child agent turn for `instructions` on a fresh threadId and
   * stream it over the session SSE. Returns the child's final assistant text.
   * `callerThreadId` is the thread whose model requested the spawn: if it is the
   * root, the child links to the main thread (parentThreadId=null); otherwise the
   * child nests under the caller (deeper recursion).
   */
  async spawn(opts: { callerThreadId: string; title: string; instructions: string }): Promise<string> {
    const childThreadId = randomUUID()
    const parentThreadId = opts.callerThreadId === this.rootId ? null : opts.callerThreadId

    // The child is itself a valid spawn context, so grandchildren route correctly.
    registerThread(childThreadId, this)

    this.emit({ type: "thread.spawn", threadId: childThreadId, parentThreadId, title: opts.title })
    this.emit({ type: "thread.status", threadId: childThreadId, status: "running", title: opts.title })

    let finalText = ""
    try {
      // A child spawned from inside the parent's tool node runs on the parent's
      // ambient callback context, which would leak the child's LLM tokens into
      // the PARENT's `messages` stream (duplicated, untagged). Create the child
      // stream with a cleared async-local store so it is fully isolated: the
      // child streams only through its OWN iterator, tagged with its threadId.
      const stream = await AsyncLocalStorageProviderSingleton.getInstance().run(undefined, () =>
        getAgent().stream(
          { messages: [{ role: "user", content: opts.instructions }] },
          {
            configurable: { thread_id: childThreadId },
            streamMode: ["updates", "messages"],
          } as any,
        ),
      )
      finalText = await translateStream(stream, childThreadId, this.emit)
    } catch (err) {
      const message = (err as Error)?.message ?? String(err)
      this.emit({ type: "error", message, threadId: childThreadId } as AgentEvent)
      finalText = `error: ${message}`
    } finally {
      this.emit({ type: "thread.status", threadId: childThreadId, status: "idle", title: opts.title })
      unregisterThread(childThreadId)
    }

    return finalText
  }
}
