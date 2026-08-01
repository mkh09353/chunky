/** Process-local notifications for the compact session-list SSE feed. */
type Listener = (sessionId: string) => void
const listeners = new Set<Listener>()

export function notifySessionChanged(sessionId: string): void {
  for (const listener of listeners) listener(sessionId)
}

export function subscribeSessionChanges(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
