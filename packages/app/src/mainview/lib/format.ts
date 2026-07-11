import type { SessionSummary } from "@chunky/protocol"

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

/** Compact relative time for a sidebar row: "now", "5m", "3h", "2d", "Jul 8". */
export function relativeTime(ms: number, now = Date.now()): string {
  const d = Math.max(0, now - ms)
  if (d < MIN) return "now"
  if (d < HOUR) return `${Math.floor(d / MIN)}m`
  if (d < DAY) return `${Math.floor(d / HOUR)}h`
  if (d < 7 * DAY) return `${Math.floor(d / DAY)}d`
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

/** Bucket a timestamp into a human recency band for section grouping. */
function bandFor(ms: number, now = Date.now()): string {
  const today = new Date(now)
  const startOfToday = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate(),
  ).getTime()
  if (ms >= startOfToday) return "Today"
  if (ms >= startOfToday - DAY) return "Yesterday"
  if (ms >= startOfToday - 7 * DAY) return "Previous 7 days"
  return "Older"
}

export interface ThreadGroup {
  band: string
  sessions: SessionSummary[]
}

/** Group already-sorted (most-recent-first) sessions into ordered recency bands. */
export function groupSessions(sessions: SessionSummary[], now = Date.now()): ThreadGroup[] {
  const ORDER = ["Today", "Yesterday", "Previous 7 days", "Older"]
  const byBand = new Map<string, SessionSummary[]>()
  for (const s of sessions) {
    const band = bandFor(s.lastActivity, now)
    const list = byBand.get(band) ?? []
    list.push(s)
    byBand.set(band, list)
  }
  return ORDER.filter((b) => byBand.has(b)).map((band) => ({
    band,
    sessions: byBand.get(band)!,
  }))
}

/** A resume-friendly label — falls back to "Untitled thread" for placeholder titles. */
export function threadLabel(title: string | undefined): string {
  const t = (title ?? "").trim()
  if (!t || t.toLowerCase() === "new session") return "Untitled thread"
  return t
}
