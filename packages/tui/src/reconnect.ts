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
