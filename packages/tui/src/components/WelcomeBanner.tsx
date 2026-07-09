import React from "react"
import { Box, Text } from "ink"
import { ACCENT, BORDER, SPARKLE } from "../theme.js"

/**
 * The start-of-session welcome card, styled like Claude Code's:
 * a rounded box, a terracotta sparkle, and a short dim byline.
 */
export function WelcomeBanner({ mode, cwd }: { mode: "mock" | "live"; cwd: string }) {
  return (
    <Box marginBottom={1}>
      <Box
        borderStyle="round"
        borderColor={ACCENT}
        paddingX={1}
        flexDirection="column"
        alignSelf="flex-start"
      >
        <Box>
          <Text color={ACCENT} bold>
            {SPARKLE}{" "}
          </Text>
          <Text bold>Welcome to MultiCode CLI</Text>
        </Box>
        <Text dimColor>
          {mode === "mock" ? "mock transcript" : "live session"} · {cwd}
        </Text>
      </Box>
    </Box>
  )
}
