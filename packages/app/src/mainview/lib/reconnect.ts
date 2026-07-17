// SSE reconnect policy, mirrored from packages/tui/src/reconnect.ts so the two
// clients back off identically.
//
// Mirrored rather than imported: this package depends only on @chunky/protocol
// (see package.json + vite.config.ts's alias) — pulling in @chunky/tui would drag
// an OpenTUI/Node renderer into the webview bundle for three pure functions. If a
// third client ever needs these, promote them into @chunky/protocol instead of
// copying again.
//
// NOTE: there is no resume cursor to reconnect *from*. `sse()` emits `data:`
// frames with no `id:`, the server ignores Last-Event-ID, and GET /events always
// replays the session's complete history before going live. So every reattach is
// a full replay, and the caller must reset its projection before consuming one.

export const RECONNECT_MAX_DELAY_MS = 30_000

/** Bounded exponential delay for an SSE attachment attempt: 500ms, 1s, 2s, 4s … 30s. */
export function reconnectDelay(attempt: number): number {
  const n = Math.max(0, Math.floor(attempt))
  return Math.min(RECONNECT_MAX_DELAY_MS, 500 * 2 ** n)
}

/** True when the stream ended because WE ended it (session switch, unmount) —
 *  those must break the retry loop instead of counting as a failure. */
export function isIntentionalAbort(error: unknown, signal: AbortSignal, cancelled = false): boolean {
  return cancelled || signal.aborted || (error instanceof Error && error.name === "AbortError")
}
