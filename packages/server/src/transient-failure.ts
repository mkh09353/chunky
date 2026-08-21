// Classify delegate transport failures that are safe to retry once in-place.
// Watchdog timeouts and mid-stream provider drops (empty completion, socket
// close, reset) are cheap to retry because LangGraph threads are checkpointed
// and the Anthropic runner resumes the same session. User interrupts, auth
// failures, and stale-runtime crashes are not transport and must not retry.
import { isStaleRuntimeError } from "./staleRuntime.ts"

const AUTH_FAILURE = /sign-in expired|\brun \/login\b|\b401\b/i
const CONNECTION_REFUSED = /ECONNREFUSED/i
const TRANSIENT_FAILURE = /empty response|socket connection was closed|fetch failed|ECONNRESET|Premature close|\bterminated\b/i
const ABORTED = /\baborted\b/i

export interface TransientFailureWatchdog {
  timedOut: () => boolean
  abort?: { signal: { aborted: boolean } }
}

function errorText(error: unknown): string {
  const seen = new Set<unknown>()
  const parts: string[] = []
  let current: unknown = error
  while (current != null && !seen.has(current)) {
    seen.add(current)
    if (current instanceof Error) {
      parts.push(current.message)
      parts.push(String(current))
      if (current.name) parts.push(current.name)
    } else {
      parts.push(String(current))
    }
    if (typeof current === "object" && current !== null && "code" in current) {
      const code = (current as { code?: unknown }).code
      if (code != null) parts.push(String(code))
    }
    current = typeof current === "object" && current !== null && "cause" in current
      ? (current as { cause?: unknown }).cause
      : undefined
  }
  return parts.join("\n")
}

/** True when a caught delegate error is a transport stall worth one retry. */
export function isTransientDelegateFailure(
  error: unknown,
  dog?: TransientFailureWatchdog,
  opts?: { userAborted?: boolean },
): boolean {
  if (opts?.userAborted) return false
  if (isStaleRuntimeError(error)) return false
  const text = errorText(error)
  if (AUTH_FAILURE.test(text) || CONNECTION_REFUSED.test(text)) return false
  if (dog?.timedOut()) return true
  if (TRANSIENT_FAILURE.test(text)) return true
  if (ABORTED.test(text)) {
    // "aborted" is retryable only when nothing else explains it. A parent/user
    // abort is already rejected above; a non-watchdog abort of the combined
    // controller is a deliberate cancel, not a dropped socket.
    if (dog?.abort?.signal.aborted && !dog.timedOut()) return false
    return true
  }
  return false
}

/** Short label for the retry notice (`transport failure (<reason>) — retrying once`). */
export function transientFailureReason(
  error: unknown,
  dog?: TransientFailureWatchdog,
): string {
  if (dog?.timedOut()) return "inactivity watchdog"
  const text = errorText(error)
  const labeled: Array<[string, RegExp]> = [
    ["empty response", /empty response/i],
    ["socket closed", /socket connection was closed/i],
    ["fetch failed", /fetch failed/i],
    ["ECONNRESET", /ECONNRESET/i],
    ["terminated", /\bterminated\b/i],
    ["premature close", /Premature close/i],
    ["aborted", /\baborted\b/i],
  ]
  for (const [label, pattern] of labeled) {
    if (pattern.test(text)) return label
  }
  const fallback = (error instanceof Error ? error.message : String(error)).trim()
  return fallback.slice(0, 80) || "transport error"
}

/** Pure retry gate: first attempt only, never after a user interrupt. */
export function shouldRetryDelegate(opts: {
  attempt: number
  transient: boolean
  userAborted: boolean
}): boolean {
  return opts.attempt === 0 && opts.transient && !opts.userAborted
}

export const DELEGATE_TRANSPORT_RETRY_PROMPT =
  "Your previous run was cut off by a transport failure mid-stream. Check what you already completed and continue idempotently to finish the brief."
