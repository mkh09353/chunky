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
import { getAgent } from "./agent.ts"
import {
  activeSelection,
  childSelection,
  providerRuntime,
  type AgentSelection,
  type AgentSelectionOverride,
} from "./providers/registry.ts"
import { registerThread, unregisterThread, type ThreadSpawner } from "./thread-context.ts"

/** The narrow part of a compiled agent that ThreadManager needs. Keeping this
 * structural lets the deterministic thread test inject a fake stream without
 * model credentials. */
export interface StreamableAgent {
  stream(...args: any[]): Promise<AsyncIterable<unknown>>
}

export type AgentForSelection = (selection: AgentSelection) => StreamableAgent

export class ThreadManager implements ThreadSpawner {
  private readonly rootId: string
  private readonly emit: Emit
  private readonly agentFor: AgentForSelection
  private readonly selections = new Map<string, AgentSelection>()

  constructor(
    emit: Emit,
    rootId: string,
    rootSelection: AgentSelection = activeSelection(),
    agentFor: AgentForSelection = getAgent,
  ) {
    this.emit = emit
    this.rootId = rootId
    this.agentFor = agentFor
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
        })
      }

      // A child spawned from inside the parent's tool node runs on the parent's
      // ambient callback context, which would leak the child's LLM tokens into
      // the PARENT's `messages` stream (duplicated, untagged). Create the child
      // stream with a cleared async-local store so it is fully isolated: the
      // child streams only through its OWN iterator, tagged with its threadId.
      const stream = await AsyncLocalStorageProviderSingleton.getInstance().run(undefined, () =>
        this.agentFor(selection).stream(
          { messages: [{ role: "user", content: opts.instructions }] },
          {
            configurable: { thread_id: childThreadId },
            streamMode: ["updates", "messages"],
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
}
