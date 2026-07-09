import React from "react"
import { Box, Text } from "ink"
import { ACCENT, SPARKLE } from "../theme.js"

/** Shorten a path to Claude Code's `/…/parent/dir` form. */
function shortCwd(cwd: string): string {
  const parts = cwd.split("/").filter(Boolean)
  if (parts.length <= 2) return "/" + parts.join("/")
  return "/…/" + parts.slice(-2).join("/")
}

/**
 * Start-of-session welcome, approximating Claude Code's: a full-width rounded
 * box with a two-column layout — greeting + sparkle logo on the left, tips and
 * "what's new" on the right, split by a vertical divider.
 */
export function WelcomeBanner({ mode, cwd }: { mode: "mock" | "live"; cwd: string }) {
  const model = mode === "live" ? "glm-5.2 · Zen" : "mock transcript"
  return (
    <Box width="100%" marginBottom={1} borderStyle="round" borderColor="gray" flexDirection="row">
      {/* left column: greeting + logo + model/cwd, centered */}
      <Box flexDirection="column" width="46%" alignItems="center" paddingY={1} paddingX={1}>
        <Text bold>Welcome to Chunky</Text>
        <Box marginY={1}>
          <Text color={ACCENT} bold>
            {SPARKLE} {SPARKLE} {SPARKLE}
          </Text>
        </Box>
        <Text dimColor>{model}</Text>
        <Text dimColor>{shortCwd(cwd)}</Text>
      </Box>
      {/* right column: tips + what's new, divided by a left border */}
      <Box
        flexGrow={1}
        flexDirection="column"
        paddingY={1}
        paddingX={2}
        borderStyle="single"
        borderColor="gray"
        borderTop={false}
        borderBottom={false}
        borderRight={false}
      >
        <Text bold>Tips for getting started</Text>
        <Text dimColor>Ask me to build something, or press / for commands</Text>
        <Box marginY={0}>
          <Text dimColor>{"─".repeat(28)}</Text>
        </Box>
        <Text bold>What&apos;s new</Text>
        <Text dimColor>Full-width Claude Code-style input bar</Text>
        <Text dimColor>Streaming transcript over SSE</Text>
      </Box>
    </Box>
  )
}
