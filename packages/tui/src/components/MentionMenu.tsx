import React from "react"
import { Box, Text } from "ink"
import figures from "figures"
import type { FileSearchItem } from "@chunky/protocol"
import { ACCENT, BORDER } from "../theme.js"

/**
 * Floating popup of FFF-ranked file/dir hits for the active @-mention.
 * Mirrors SlashMenu styling so both autocompletes feel like one system.
 */
export function MentionMenu({
  items,
  selected,
  query,
}: {
  items: FileSearchItem[]
  selected: number
  query: string
}) {
  if (items.length === 0) {
    return (
      <Box borderStyle="round" borderColor={BORDER} flexDirection="column" paddingX={1}>
        <Text dimColor>no files match @{query || "…"}</Text>
      </Box>
    )
  }
  return (
    <Box borderStyle="round" borderColor={BORDER} flexDirection="column" paddingX={1}>
      {items.map((item, i) => {
        const focused = i === selected
        const kindMark = item.kind === "directory" ? "/" : ""
        return (
          <Box key={`${item.kind}:${item.path}`}>
            <Text color={ACCENT}>{focused ? figures.pointer : " "} </Text>
            <Text color={focused ? ACCENT : undefined} bold={focused}>
              {item.path}
              {kindMark}
            </Text>
          </Box>
        )
      })}
    </Box>
  )
}

/**
 * Detect an in-progress @-mention at the cursor.
 * Trigger: `@` at start-of-token (start of input, or after whitespace).
 * Query runs until whitespace or another @. Returns null when not in a mention.
 */
export function activeMention(
  value: string,
  cursor: number,
): { start: number; query: string } | null {
  // Scan left from cursor for the nearest @ that starts a token.
  let i = cursor - 1
  while (i >= 0) {
    const ch = value[i]!
    if (ch === "@") {
      // Valid only if start of string or preceded by whitespace.
      if (i === 0 || /\s/.test(value[i - 1]!)) {
        const query = value.slice(i + 1, cursor)
        // Abort if query itself has whitespace (mention already closed).
        if (/\s/.test(query)) return null
        return { start: i, query }
      }
      return null
    }
    // Hit whitespace before finding @ → no active mention.
    if (/\s/.test(ch)) return null
    i--
  }
  return null
}
