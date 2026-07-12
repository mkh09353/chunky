// Inter-session message bus. All sessions live in THIS server process, so
// "send a message to another session" (the send_to_session tool) needs no
// sockets — just a way to reach index.ts's dispatch/emit machinery without a
// module cycle. index.ts installs its implementations at startup via
// installSessionBus(); the tools import only this module.
//
// Delivery semantics (port of pi's control extension, minus "steer" — our
// runtime can't inject into an in-flight LangGraph turn):
// - target idle    -> the message starts a turn immediately
// - target running -> the message is queued and starts a turn when the current
//                     one (including any goal continuations) finishes
// Queued messages never abort in-flight work, unlike a user POST /messages.
import type { AgentEvent } from "@chunky/protocol"

export interface SessionBusImpl {
  /** Emit (persist + fan out) one already-shaped event to a session's stream. */
  emitUserMessage(sessionId: string, text: string, from: string): void
  /** Emit (persist + fan out) an arbitrary protocol event to a session's stream —
   *  e.g. the goal.update marker a ship_goal stamps onto the session it creates. */
  emitEvent(sessionId: string, ev: AgentEvent): void
  /** Start an agent run on the session. Resolves when the run fully completes. */
  dispatch(sessionId: string, text: string): Promise<void>
  /** Whether the session has an in-flight run right now. */
  isRunning(sessionId: string): boolean
}

interface QueuedMessage {
  /** The prompt handed to the model (includes the sender_info envelope). */
  prompt: string
  /** The visible message text (envelope stripped) for the transcript event. */
  shown: string
  /** Short human label of the sending session. */
  from: string
  /** Resolves when the delivered message's run completes. */
  resolve: () => void
}

let impl: SessionBusImpl | null = null
const queues = new Map<string, QueuedMessage[]>()

/** Max messages parked behind a busy session — a backstop against a runaway
 *  sender, not a throughput knob. */
export const MAX_QUEUED = 10

export function installSessionBus(i: SessionBusImpl): void {
  impl = i
}

/** Test seam: uninstall + drop all queues. */
export function resetSessionBus(): void {
  impl = null
  queues.clear()
}

export function busInstalled(): boolean {
  return impl != null
}

export function queuedCount(sessionId: string): number {
  return queues.get(sessionId)?.length ?? 0
}

/** Whether the session has an in-flight run (false when the bus isn't up). */
export function sessionIsRunning(sessionId: string): boolean {
  return impl?.isRunning(sessionId) ?? false
}

/** Emit an arbitrary protocol event onto a session's stream (persist + fan out).
 *  Throws when the bus isn't installed — callers gate on busInstalled(). */
export function emitToSession(sessionId: string, ev: AgentEvent): void {
  if (!impl) throw new Error("session bus not installed (server not fully started)")
  impl.emitEvent(sessionId, ev)
}

function startDelivery(sessionId: string, msg: QueuedMessage): void {
  const bus = impl!
  bus.emitUserMessage(sessionId, msg.shown, msg.from)
  void bus
    .dispatch(sessionId, msg.prompt)
    .catch(() => {
      // dispatch/run errors surface on the TARGET's stream; the sender only
      // cares that the attempt finished.
    })
    .finally(() => {
      msg.resolve()
      drainQueue(sessionId)
    })
}

/**
 * Deliver a message to `sessionId`: immediately when idle, queued behind the
 * current run otherwise. Returns how it was delivered plus a promise that
 * resolves when the message's own run has completed (for wait_for_reply).
 */
export function deliverToSession(
  sessionId: string,
  message: { prompt: string; shown: string; from: string },
): { delivered: "now" | "queued"; done: Promise<void> } {
  if (!impl) throw new Error("session bus not installed (server not fully started)")

  let resolve!: () => void
  const done = new Promise<void>((r) => {
    resolve = r
  })
  const queued: QueuedMessage = { ...message, resolve }

  if (impl.isRunning(sessionId) || queuedCount(sessionId) > 0) {
    const q = queues.get(sessionId) ?? []
    if (q.length >= MAX_QUEUED) throw new Error(`session ${sessionId} already has ${MAX_QUEUED} queued messages`)
    q.push(queued)
    queues.set(sessionId, q)
    return { delivered: "queued", done }
  }

  startDelivery(sessionId, queued)
  return { delivered: "now", done }
}

/** Called by index.ts whenever a session's run finishes: if messages are parked
 *  behind it, start the next one. (Also self-called between queued messages.) */
export function drainQueue(sessionId: string): void {
  if (!impl || impl.isRunning(sessionId)) return
  const q = queues.get(sessionId)
  const next = q?.shift()
  if (!next) {
    queues.delete(sessionId)
    return
  }
  startDelivery(sessionId, next)
}
