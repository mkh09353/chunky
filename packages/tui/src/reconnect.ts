export const RECONNECT_MAX_DELAY_MS = 30_000

/** Bounded exponential delay for an SSE attachment attempt. */
export function reconnectDelay(attempt: number): number {
  const n = Math.max(0, Math.floor(attempt))
  return Math.min(RECONNECT_MAX_DELAY_MS, 500 * 2 ** n)
}

export function isIntentionalAbort(error: unknown, signal: AbortSignal, cancelled: boolean): boolean {
  return cancelled || signal.aborted || (error instanceof Error && error.name === "AbortError")
}

export function retryableHttpMessage(status: number): string {
  return `Reconnecting… (server unavailable: HTTP ${status})`
}

/** Sleep that ends immediately when the attachment is intentionally cancelled. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    const onAbort = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
      resolve()
    }
    function done() {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

/** Consecutive failures against a reachable-but-unhappy server before the TUI
 *  looks for a replacement; a refused connection needs fewer. */
export const RERESOLVE_AFTER_ATTEMPTS = 3
export const RERESOLVE_AFTER_REFUSED_ATTEMPTS = 2

/** Does this error mean nothing is listening on that port any more? Bun, Node
 *  and fetch polyfills all word it differently. */
export function isConnectionRefused(error: unknown): boolean {
  if (!error) return false
  const code = (error as { code?: unknown }).code
  if (typeof code === "string" && /ConnectionRefused|ECONNREFUSED|ECONNRESET/i.test(code)) return true
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  return /unable to connect|connection refused|econnrefused|failed to fetch|fetch failed|socket connection was closed/i
    .test(message)
}

/**
 * Whether a lost attachment means "this server moved" rather than "the network
 * hiccuped". Transient drops against a live server must keep their existing
 * retry-the-same-address behaviour.
 */
export function shouldReresolve(input: { attempts: number; error?: unknown; retiring?: boolean }): boolean {
  if (input.retiring) return true
  if (isConnectionRefused(input.error)) return input.attempts >= RERESOLVE_AFTER_REFUSED_ATTEMPTS
  return input.attempts >= RERESOLVE_AFTER_ATTEMPTS
}
