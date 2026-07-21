import type { SessionSummary } from "@chunky/protocol"
import type { CreatedSession } from "./api"

/**
 * Is the ATTACHED thread off the record?
 *
 * The server owns the flag and fixes it when the session is created, so the
 * session list is the source of truth — it carries `incognito` for every thread.
 * `created` seeds the answer for a thread we just made, whose row hasn't come
 * back from the list yet, and is ignored once the ids no longer match.
 *
 * Deliberately `=== true`: a server that doesn't send the field yet means "not
 * incognito", never "maybe" — an undefined flag must never paint the UI red, and
 * must never leave it purple when the server said true.
 */
export function activeIncognito(
  sessions: SessionSummary[],
  sessionId: string | null,
  created: CreatedSession | null,
): boolean {
  if (!sessionId) return false
  const row = sessions.find((s) => s.sessionId === sessionId)
  if (row) return row.incognito === true
  return created?.sessionId === sessionId && created.incognito === true
}
