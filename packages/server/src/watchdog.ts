// Delegate inactivity watchdog. A delegate (sidekick, advisor, spawned child,
// workflow agent) that silently stalls — provider stream hangs, SDK deadlock —
// used to block its awaited tool promise FOREVER with zero signal to the lead
// or the user (a "32 minutes then nothing" hang). The watchdog wraps the
// delegate's emitter: every event the delegate streams (message deltas, tool
// start/end, reasoning) resets an idle timer; if NO event arrives for the
// timeout window, the watchdog aborts the delegate's run and the caller
// returns an explicit, actionable error instead of hanging.
//
// The timeout is measured on STREAM activity, not wall clock — a delegate
// grinding through many tool calls for an hour never trips it, but one whose
// provider connection died mid-request does. The default window is generous
// (15 min) because a single long tool call (a big build/test run) emits nothing
// between tool.start and tool.end.
import type { Emit } from "./event-emitter.ts"

const DEFAULT_IDLE_MINUTES = 15

/** Idle window in ms; CHUNKY_DELEGATE_IDLE_MINUTES overrides (0 disables). */
export function delegateIdleTimeoutMs(): number {
  const raw = process.env.CHUNKY_DELEGATE_IDLE_MINUTES
  if (raw !== undefined) {
    const minutes = Number(raw)
    if (Number.isFinite(minutes)) return Math.max(0, minutes) * 60_000
  }
  return DEFAULT_IDLE_MINUTES * 60_000
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
}): DelegateWatchdog {
  const timeoutMs = opts.timeoutMs ?? delegateIdleTimeoutMs()
  const controller = new AbortController()
  let fired = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const message = () =>
    `${opts.label} produced no stream activity for ${Math.round(timeoutMs / 60_000)} minutes and was killed by the ` +
    `inactivity watchdog — the provider connection likely stalled. Re-send the brief (or raise ` +
    `CHUNKY_DELEGATE_IDLE_MINUTES if its work legitimately goes quiet longer than this).`

  const arm = () => {
    if (timeoutMs <= 0 || fired) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      fired = true
      controller.abort(new Error(message()))
    }, timeoutMs)
    // Never keep the process alive just to watch a delegate.
    ;(timer as { unref?: () => void }).unref?.()
  }

  const onParentAbort = () => controller.abort(opts.parent?.signal.reason)
  opts.parent?.signal.addEventListener("abort", onParentAbort, { once: true })
  if (opts.parent?.signal.aborted) onParentAbort()

  arm()
  return {
    emit: (event) => {
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
