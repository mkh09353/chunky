// Desktop notification when a turn finishes, via the standard web Notification
// API (feature-detected — silently a no-op where the webview doesn't support
// it). Only fires when the window is hidden/backgrounded: if you're looking at
// the app you can see the turn finish.

/** Turns shorter than this don't notify: quick turns mean the user is right
 *  there, and history replay on (re)attach processes events in milliseconds. */
export const MIN_NOTIFY_MS = 3_000

export function notifyTurnEnd(finalText: string): void {
  if (typeof Notification === "undefined") return
  if (typeof document !== "undefined" && !document.hidden) return
  const normalized = finalText.replace(/\s+/g, " ").trim()
  const body = normalized.length > 200 ? normalized.slice(0, 199) + "…" : normalized
  if (Notification.permission === "granted") {
    new Notification("Chunky", { body: body || "Ready for input" })
  } else if (Notification.permission === "default") {
    // First time: ask now so the NEXT turn can notify.
    void Notification.requestPermission()
  }
}
