import { TextAttributes } from "@opentui/core"
import type { SessionSummary } from "@chunky/protocol"
import { ACCENT, BORDER } from "../theme.js"

/** Rows visible at once; longer lists scroll this window around the selection. */
export const RESUME_WINDOW = 10

/** Compact "how long ago" label for a resume row: "just now", then m/h/d. */
export function ago(ts: number, now: number = Date.now()): string {
  const mins = Math.round(Math.max(0, now - ts) / 60_000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

/** First index of the window shown around `selected` (newest-first list). */
export function windowStart(selected: number, total: number, window = RESUME_WINDOW): number {
  return Math.max(0, Math.min(selected - (window >> 1), total - window))
}

/**
 * Arrow-navigable thread picker shown by /resume. ↑/↓ move, enter reattaches to
 * the highlighted thread (its full history replays), esc cancels. Styled like
 * the login picker; the list arrives newest-first from the server.
 */
export function ResumePicker({ sessions, selected }: { sessions: SessionSummary[]; selected: number }) {
  const start = windowStart(selected, sessions.length)
  const visible = sessions.slice(start, start + RESUME_WINDOW)
  const older = sessions.length - start - visible.length
  return (
    <box flexDirection="column" border borderStyle="rounded" borderColor={BORDER} paddingX={1} marginBottom={1}>
      <text attributes={TextAttributes.DIM}>Resume a thread — ↑/↓ move · enter resume · esc cancel</text>
      {start > 0 && <text attributes={TextAttributes.DIM}>{`  … ${start} newer`}</text>}
      {visible.map((s, i) => {
        const on = start + i === selected
        return (
          <box key={s.sessionId} flexDirection="row">
            <text fg={on ? ACCENT : undefined}>{on ? "❯ " : "  "}</text>
            <text fg={on ? ACCENT : undefined} attributes={on ? TextAttributes.BOLD : 0}>
              {s.title}
            </text>
            <text attributes={TextAttributes.DIM}>{"  — " + ago(s.lastActivity)}</text>
          </box>
        )
      })}
      {older > 0 && <text attributes={TextAttributes.DIM}>{`  … ${older} older`}</text>}
    </box>
  )
}
