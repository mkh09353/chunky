import { useEffect, useState } from "react"
import { TextAttributes } from "@opentui/core"
import { ACCENT, SPINNER_FRAMES, SPINNER_VERBS } from "../theme.js"

/**
 * Claude Code's running status line: an animated violet sparkle, a
 * rotating verb ("Thinking…", "Working…"), and an elapsed-seconds timer.
 * Rendered only while the agent is running.
 */
export function StatusLine({ startedAt, reconnecting = false }: { startedAt?: number; reconnecting?: boolean }) {
  const [frame, setFrame] = useState(0)
  const [verb, setVerb] = useState(() => pickVerb())
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    const spin = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 90)
    const tick = startedAt == null ? undefined : setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 250)
    const verbs = setInterval(() => setVerb(pickVerb()), 3200)
    return () => {
      clearInterval(spin)
      if (tick) clearInterval(tick)
      clearInterval(verbs)
    }
  }, [startedAt])

  return (
    <box flexDirection="row" marginTop={1}>
      <text fg={ACCENT}>{SPINNER_FRAMES[frame]} </text>
      <text fg={ACCENT} attributes={TextAttributes.BOLD}>
        {reconnecting ? "Reconnecting…" : `${verb}…`}
      </text>
      {!reconnecting && <text attributes={TextAttributes.DIM}> ({elapsed}s · esc to interrupt)</text>}
    </box>
  )
}

function pickVerb(): string {
  return SPINNER_VERBS[Math.floor(Math.random() * SPINNER_VERBS.length)]!
}

/**
 * The idle "work is still happening off-turn" line: `◎ watching · 2 tasks · 1
 * monitor`. A count of 0 drops its whole segment, and with nothing running at
 * all this returns null — the caller renders nothing rather than an empty line.
 */
export function formatWatching(tasks: number, monitors: number): string | null {
  const segments: string[] = []
  if (tasks > 0) segments.push(`${tasks} task${tasks === 1 ? "" : "s"}`)
  if (monitors > 0) segments.push(`${monitors} monitor${monitors === 1 ? "" : "s"}`)
  return segments.length ? `◎ watching · ${segments.join(" · ")}` : null
}

/**
 * Shown in the spinner's place while the session is IDLE but background bash
 * tasks or monitors are still running. The running spinner always wins — the
 * caller never renders both — so this is purely the quiet, between-turns state.
 */
export function WatchingLine({ tasks, monitors }: { tasks: number; monitors: number }) {
  const label = formatWatching(tasks, monitors)
  if (!label) return null
  return (
    <box flexDirection="row" marginTop={1}>
      <text attributes={TextAttributes.DIM}>{label}</text>
    </box>
  )
}
