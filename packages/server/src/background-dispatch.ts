// Server-owned bridge for background-task notifications. Kept separate from
// tasks.ts so the task registry never imports index.ts (and creates a cycle).
export interface BackgroundDispatcher {
  isRunning(sessionId: string): boolean
  wake(sessionId: string, prompt: string, shownText: string): void
  changed(sessionId: string): void
}
export function backgroundChanged(sessionId: string): void { dispatcher?.changed(sessionId) }
let dispatcher: BackgroundDispatcher | null = null
export function installBackgroundDispatcher(next: BackgroundDispatcher): void { dispatcher = next }
export function resetBackgroundDispatcher(): void { dispatcher = null }
/** Returns whether a notice was turned into an idle wake rather than queued. */
export function routeBackgroundNotice(sessionId: string, prompt: string, shownText: string): "wake" | "reminder" {
  if (dispatcher && !dispatcher.isRunning(sessionId)) { dispatcher.wake(sessionId, prompt, shownText); return "wake" }
  return "reminder"
}
/** Internal task-facing wake helper. */
export function wakeSession(sessionId: string, prompt: string, shownText: string): void {
  if (dispatcher) dispatcher.wake(sessionId, prompt, shownText)
}
