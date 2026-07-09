import React, { useEffect, useState } from "react"
import { Box, Text } from "ink"
import { ACCENT, SPINNER_FRAMES, SPINNER_VERBS } from "../theme.js"

/**
 * Claude Code's running status line: an animated terracotta sparkle, a
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
    <Box marginTop={1}>
      <Text color={ACCENT}>{SPINNER_FRAMES[frame]} </Text>
      <Text color={ACCENT} bold>
        {verb}…
      </Text>
      <Text dimColor> ({elapsed}s · esc to interrupt)</Text>
    </Box>
  )
}

function pickVerb(): string {
  return SPINNER_VERBS[Math.floor(Math.random() * SPINNER_VERBS.length)]!
}
