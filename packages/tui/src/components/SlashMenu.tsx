import React from "react"
import { Box, Text } from "ink"
import figures from "figures"
import { ACCENT, BORDER } from "../theme.js"

export interface Command {
  name: string
  description: string
}

export const COMMANDS: Command[] = [
  { name: "/clear", description: "Clear the conversation" },
  { name: "/help", description: "Show help" },
  { name: "/login", description: "Log in to an OAuth provider (Grok / Codex)" },
  { name: "/model", description: "Pick a model (provider, model, effort/speed)" },
  { name: "/advisor", description: "Set the advisor model (a stronger model, on tap)" },
  { name: "/quit", description: "Exit Chunky CLI" },
]

/**
 * The slash-command popup, styled after kimi's CustomSelect: a rounded box
 * floating above the input, a violet pointer (❯) on the focused row,
 * highlighted label + dim description.
 */
export function SlashMenu({ commands, selected }: { commands: Command[]; selected: number }) {
  if (commands.length === 0) return null
  return (
    <Box borderStyle="round" borderColor={BORDER} flexDirection="column" paddingX={1} marginBottom={0}>
      {commands.map((cmd, i) => {
        const focused = i === selected
        return (
          <Box key={cmd.name}>
            <Text color={ACCENT}>{focused ? figures.pointer : " "} </Text>
            <Text color={focused ? ACCENT : undefined} bold={focused}>
              {cmd.name}
            </Text>
            <Text dimColor> — {cmd.description}</Text>
          </Box>
        )
      })}
    </Box>
  )
}
