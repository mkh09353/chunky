import React from "react"
import { Box, Text } from "ink"
import { ChunkyLogo } from "./ChunkyLogo.js"
import { ACCENT } from "../theme.js"

/** Shorten a path to Claude Code's `/…/parent/dir` form. */
function shortCwd(cwd: string): string {
  const parts = cwd.split("/").filter(Boolean)
  if (parts.length <= 2) return "/" + parts.join("/")
  return "/…/" + parts.slice(-2).join("/")
}

/**
 * Start-of-session welcome: a full-width rounded box with a single centered
 * column — the greeting, the Chunky mascot, the active model + cwd, and the
 * (only) mode we run in.
 */
export function WelcomeBanner({
  mode,
  cwd,
  model,
}: {
  mode: "mock" | "live"
  cwd: string
  /** The active model label (real selection, not hardcoded). */
  model: string
}) {
  return (
    <Box
      width="100%"
      marginBottom={1}
      borderStyle="round"
      borderColor="gray"
      flexDirection="column"
      alignItems="center"
      paddingY={1}
      paddingX={1}
    >
      <Text bold>Welcome to Chunky</Text>
      <Box marginY={1}>
        <ChunkyLogo />
      </Box>
      <Text dimColor>{model}</Text>
      <Text dimColor>{shortCwd(cwd)}</Text>
      <Text dimColor>
        mode: <Text color={ACCENT}>all yolo, all the time</Text>
      </Text>
    </Box>
  )
}
