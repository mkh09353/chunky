/** Build the @-mention search URL. Session scope wins server-side, so a resumed
 * or worktree session searches its pinned workspace rather than a global repo. */
export function fileSearchUrl(baseUrl: string, query: string, sessionId?: string): string {
  const params = new URLSearchParams({ q: query, limit: "12" })
  if (sessionId) params.set("session", sessionId)
  return `${baseUrl}/api/files/search?${params.toString()}`
}

/** A response may update the picker only if no later mention invalidated it. */
export function isCurrentFileSearch(generation: number, currentGeneration: number): boolean {
  return generation === currentGeneration
}

/** State transition when the visible @ query changes. Clearing immediately
 * prevents results for the prior query from being rendered during debounce. */
export function beginFileSearch(): { items: []; loading: true } {
  return { items: [], loading: true }
}
