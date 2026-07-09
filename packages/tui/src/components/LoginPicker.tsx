import React from "react"
import { Box, Text } from "ink"
import { ACCENT, BORDER } from "../theme.js"

export interface ProviderRow {
  id: string
  label: string
  ready: boolean
  active: boolean
}

/**
 * Arrow-navigable provider picker shown by /login. ↑/↓ move, enter initiates the
 * login for the highlighted provider, esc cancels. Styled like the slash menu.
 */
export function LoginPicker({ providers, selected }: { providers: ProviderRow[]; selected: number }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={BORDER} paddingX={1} marginBottom={1}>
      <Text dimColor>Log in to a provider — ↑/↓ move · enter select · esc cancel</Text>
      {providers.map((p, i) => {
        const on = i === selected
        return (
          <Box key={p.id}>
            <Text color={on ? ACCENT : undefined}>{on ? "❯ " : "  "}</Text>
            <Text color={on ? ACCENT : undefined} bold={on}>
              {p.ready ? "●" : "○"} {p.id}
            </Text>
            <Text dimColor>
              {"  — " + p.label}
              {p.ready ? " [logged in]" : ""}
              {p.active ? " (active)" : ""}
            </Text>
          </Box>
        )
      })}
    </Box>
  )
}
