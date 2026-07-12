import { useEffect, useState } from "react"
import { TextAttributes } from "@opentui/core"
import { ACCENT, SPINNER_FRAMES, SPINNER_VERBS } from "../theme.js"

/**
 * Claude Code's running status line: an animated violet sparkle, a
 * rotating verb ("Thinking…", "Working…"), and an elapsed-seconds timer.
 * Rendered only while the agent is running.
 */
export function StatusLine({ startedAt }: { startedAt: number }) {
  const [frame, setFrame] = useState(0)
  const [verb, setVerb] = useState(() => pickVerb())
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    const spin = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 90)
    const tick = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 250)
    const verbs = setInterval(() => setVerb(pickVerb()), 3200)
    return () => {
      clearInterval(spin)
      clearInterval(tick)
      clearInterval(verbs)
    }
  }, [startedAt])

  return (
    <box flexDirection="row" marginTop={1}>
      <text fg={ACCENT}>{SPINNER_FRAMES[frame]} </text>
      <text fg={ACCENT} attributes={TextAttributes.BOLD}>
        {verb}…
      </text>
      <text attributes={TextAttributes.DIM}> ({elapsed}s · esc to interrupt)</text>
    </box>
  )
}

function pickVerb(): string {
  return SPINNER_VERBS[Math.floor(Math.random() * SPINNER_VERBS.length)]!
}
