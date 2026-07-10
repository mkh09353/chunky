import React from "react"
import { Box, Text } from "ink"
import { CHUNKY_LOGO } from "./chunky-logo-art.js"

/**
 * Chunky's mascot rendered as truecolor half-block ANSI art. Each entry of
 * CHUNKY_LOGO is one terminal row whose cells already carry their own 24-bit
 * SGR color codes; Ink passes the raw escapes through unchanged (widths are
 * measured ANSI-aware). `wrap="truncate"` clips rather than wrapping if the
 * terminal is narrower than the art, so the rows never break mid-image.
 * Needs a truecolor terminal; older terminals show approximate/!mono colors.
 */
export function ChunkyLogo() {
  return (
    <Box flexDirection="column" alignItems="flex-start">
      {CHUNKY_LOGO.map((row, i) => (
        <Text key={i} wrap="truncate">
          {row}
        </Text>
      ))}
    </Box>
  )
}
