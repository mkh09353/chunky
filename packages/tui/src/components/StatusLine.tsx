import { useEffect, useState } from "react"
import { TextAttributes } from "@opentui/core"
import { ACCENT, INCOGNITO_LABEL, SPINNER_FRAMES, SPINNER_VERBS } from "../theme.js"
import type { StatusSegment } from "./PromptInput.js"

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
 * The INCOGNITO chip for the input's bottom-rule status row — first chip, so it
 * reads before the model. It takes no explicit color: ACCENT is ALREADY the
 * bright red while the attached session is incognito (see setIncognitoTheme),
 * which is exactly the state that makes this chip appear. A normal session gets
 * null and the status row is byte-for-byte what it was before.
 */
export function incognitoSegment(incognito: boolean): StatusSegment | null {
  return incognito ? { text: INCOGNITO_LABEL, color: ACCENT } : null
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
