// Delegate inactivity watchdog. A delegate (sidekick, advisor, spawned child,
// workflow agent) that silently stalls — provider stream hangs, SDK deadlock —
// used to block its awaited tool promise FOREVER with zero signal to the lead
// or the user (a "32 minutes then nothing" hang). The watchdog wraps the
// delegate's emitter: every event the delegate streams (message deltas, tool
// start/end, reasoning) resets an idle timer; if NO event arrives for the
// timeout window, the watchdog aborts the delegate's run and the caller
// returns an explicit, actionable error instead of hanging.
//
// Two idle windows apply, because the same silence means different things
// depending on what the delegate is waiting on. A long local tool call (a big
// build/test) emits nothing between tool.start and tool.end, so the tool
// window (default 15 min, CHUNKY_DELEGATE_IDLE_MINUTES) stays generous. When
// no tool is pending we are waiting on the provider to stream tokens —
// multi-minute silence means the connection is dead, so the stream window
// (default 4 min, CHUNKY_DELEGATE_STALL_MINUTES) is short. tool.start /
// tool.end events flowing through the wrapper keep a pending-tool count;
// tool.progress is activity like any other event. CHUNKY_DELEGATE_IDLE_MINUTES=0
// disables the watchdog; CHUNKY_DELEGATE_STALL_MINUTES=0 disables only the
// short window (falls back to the tool window). The stream window never
// exceeds the tool window.
import type { Emit } from "./event-emitter.ts"

const DEFAULT_IDLE_MINUTES = 15
const DEFAULT_STALL_MINUTES = 4

function minutesEnvMs(raw: string | undefined, fallbackMinutes: number): number {
  if (raw !== undefined) {
    const minutes = Number(raw)
    if (Number.isFinite(minutes)) return Math.max(0, minutes) * 60_000
  }
  return fallbackMinutes * 60_000
}

/** Idle (tool) window in ms; CHUNKY_DELEGATE_IDLE_MINUTES overrides (0 disables). */
export function delegateIdleTimeoutMs(): number {
  return minutesEnvMs(process.env.CHUNKY_DELEGATE_IDLE_MINUTES, DEFAULT_IDLE_MINUTES)
}

/** Stream-stall window in ms; CHUNKY_DELEGATE_STALL_MINUTES overrides (0 → tool window). */
export function delegateStallTimeoutMs(): number {
  return minutesEnvMs(process.env.CHUNKY_DELEGATE_STALL_MINUTES, DEFAULT_STALL_MINUTES)
}

function effectiveStreamTimeoutMs(toolMs: number, stallMs: number): number {
  if (toolMs <= 0) return 0
  if (stallMs <= 0) return toolMs
  return Math.min(stallMs, toolMs)
}

/** Effective tool/stream windows after env overrides, 0-disable, and stall≤idle clamp. */
export function delegateWatchdogWindows(): { toolMs: number; streamMs: number } {
  const toolMs = delegateIdleTimeoutMs()
  return { toolMs, streamMs: effectiveStreamTimeoutMs(toolMs, delegateStallTimeoutMs()) }
}

export interface DelegateWatchdog {
  /** Pass THIS emitter into the delegate's run — every event resets the timer. */
  emit: Emit
  /** Combined controller: aborts on watchdog timeout AND follows the parent
   *  (user-interrupt) controller. Pass to the delegate's stream/SDK run. */
  abort: AbortController
  /** True once the watchdog fired (distinguishes timeout from user interrupt). */
  timedOut: () => boolean
  /** The error string the caller should return when timedOut(). */
  timeoutMessage: () => string
  /** Stop the timer and detach the parent-abort listener. ALWAYS call in finally. */
  dispose: () => void
}

/**
 * Create a watchdog for one delegate run. `label` names the delegate in the
 * timeout message ("sidekick", "child thread", …); `parent` is the session
 * turn's abort controller so a user Esc still tears the delegate down.
 */
export function createDelegateWatchdog(opts: {
  emit: Emit
  label: string
  parent?: AbortController
  timeoutMs?: number
  stallMs?: number
}): DelegateWatchdog {
  const toolMs = opts.timeoutMs ?? delegateIdleTimeoutMs()
  const streamMs = effectiveStreamTimeoutMs(toolMs, opts.stallMs ?? delegateStallTimeoutMs())
  const controller = new AbortController()
  let fired = false
  let pendingTools = 0
  let firedPending = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  const windowMs = (pending: number) => (pending > 0 ? toolMs : streamMs)

  const messageFor = (pending: number) => {
    const timeoutMs = windowMs(pending)
    const phase = pending > 0
      ? "during a tool call"
      : "while waiting for model output"
    const envVar = pending > 0 || streamMs >= toolMs
      ? "CHUNKY_DELEGATE_IDLE_MINUTES"
      : "CHUNKY_DELEGATE_STALL_MINUTES"
    return `${opts.label} produced no stream activity for ${Math.round(timeoutMs / 60_000)} minutes ${phase} and was killed by the ` +
      `inactivity watchdog — the provider connection likely stalled. Re-send the brief (or raise ` +
      `${envVar} if its work legitimately goes quiet longer than this).`
  }

  const message = () => messageFor(fired ? firedPending : pendingTools)

  const arm = () => {
    if (toolMs <= 0 || fired) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      fired = true
      firedPending = pendingTools
      controller.abort(new Error(message()))
    }, windowMs(pendingTools))
    // Never keep the process alive just to watch a delegate.
    ;(timer as { unref?: () => void }).unref?.()
  }

  const onParentAbort = () => controller.abort(opts.parent?.signal.reason)
  opts.parent?.signal.addEventListener("abort", onParentAbort, { once: true })
  if (opts.parent?.signal.aborted) onParentAbort()

  arm()
  return {
    emit: (event) => {
      if (event.type === "tool.start") pendingTools += 1
      else if (event.type === "tool.end") pendingTools = Math.max(0, pendingTools - 1)
      arm()
      opts.emit(event)
    },
    abort: controller,
    timedOut: () => fired,
    timeoutMessage: message,
    dispose: () => {
      if (timer) clearTimeout(timer)
      timer = undefined
      opts.parent?.signal.removeEventListener("abort", onParentAbort)
    },
  }
}
