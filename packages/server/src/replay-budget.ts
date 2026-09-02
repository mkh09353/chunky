/**
 * Replay budget for the v2 session event stream.
 *
 * A cursor-driven reconnect may ask the server to replay every durable event
 * between the client's cursor and the current boundary. A stale cursor, a
 * replay-reset (history rewritten or cursor ahead), or a very long session
 * would otherwise materialize the whole transcript in memory. The server runs
 * a SQL preflight over that range and, when it exceeds this budget, answers
 * with `replay-too-large` so the client rebuilds from the bounded history-tail
 * endpoint instead. Pure helpers only; the store owns the SQL.
 */

export const DEFAULT_REPLAY_MAX_EVENTS = 2000
export const DEFAULT_REPLAY_MAX_BYTES = 8 * 1024 * 1024 // 8 MiB

export const REPLAY_MAX_EVENTS_ENV = "CHUNKY_REPLAY_MAX_EVENTS"
export const REPLAY_MAX_BYTES_ENV = "CHUNKY_REPLAY_MAX_BYTES"

export type ReplayBudget = { maxEvents: number; maxBytes: number }
export type ReplayRangeStats = { events: number; bytes: number }

/** Strict positive integer parsing: digits only, no sign, no exponent, no
 * fraction, and within the safe-integer range. Anything else -> fallback. */
export function parsePositiveInteger(raw: string | undefined | null, fallback: number): number {
  if (typeof raw !== "string") return fallback
  const trimmed = raw.trim()
  if (!/^\d+$/.test(trimmed)) return fallback
  const value = Number(trimmed)
  if (!Number.isSafeInteger(value) || value <= 0) return fallback
  return value
}

export function readReplayBudget(env: Record<string, string | undefined> = process.env): ReplayBudget {
  return {
    maxEvents: parsePositiveInteger(env[REPLAY_MAX_EVENTS_ENV], DEFAULT_REPLAY_MAX_EVENTS),
    maxBytes: parsePositiveInteger(env[REPLAY_MAX_BYTES_ENV], DEFAULT_REPLAY_MAX_BYTES),
  }
}

/** True when a replay of `stats` must be refused. Either limit is sufficient;
 * a range exactly at a limit is still allowed. */
export function replayExceedsBudget(stats: ReplayRangeStats, budget: ReplayBudget): boolean {
  return stats.events > budget.maxEvents || stats.bytes > budget.maxBytes
}

/** Parsed once at module load; the server process does not re-read env. */
export const REPLAY_BUDGET: ReplayBudget = readReplayBudget()
