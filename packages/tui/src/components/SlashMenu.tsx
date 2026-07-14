import { TextAttributes } from "@opentui/core"
import figures from "figures"
import { ACCENT, BORDER } from "../theme.js"

export interface Command {
  name: string
  description: string
}

export const COMMANDS: Command[] = [
  { name: "/clear", description: "Clear the conversation" },
  { name: "/resume", description: "Resume a previous thread in this repo" },
  { name: "/help", description: "Show help" },
  { name: "/login", description: "Log in to an OAuth provider (Grok / Codex)" },
  { name: "/onboard", description: "Open the first-run onboarding guide" },
  { name: "/model", description: "Pick or manage models (/model add|hide|restore|list)" },
  { name: "/skills", description: "Manage skill repos (/skills add|remove|update|list)" },
  { name: "/provider", description: "Configure available models for a provider" },
  { name: "/workers", description: "Inspect or tune automatic workflow model routing" },
  { name: "/advisor", description: "Set the advisor model (a stronger model, on tap)" },
  { name: "/sidekick", description: "Set the sidekick model; /sidekick <name> adds a named seat (frontend/backend)" },
  { name: "/mode", description: "Named model+sidekick+advisor trios (/mode <name>, /mode save <name>)" },
  { name: "/goal", description: "Work autonomously toward a goal (/goal [--workflows] <objective>)" },
  { name: "/shipit", description: "Hand this plan off to a fresh goal-orchestrator session (/shipit [notes])" },
  { name: "/cacheguard", description: "Confirm before re-sending a big cold cache (/cacheguard 100k|off)" },
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
    <box border borderStyle="rounded" borderColor={BORDER} flexDirection="column" paddingX={1}>
      {commands.map((cmd, i) => {
        const focused = i === selected
        return (
          <box key={cmd.name} flexDirection="row">
            <text fg={ACCENT}>{focused ? figures.pointer : " "} </text>
            <text fg={focused ? ACCENT : undefined} attributes={focused ? TextAttributes.BOLD : 0}>
              {cmd.name}
            </text>
            <text attributes={TextAttributes.DIM}> — {cmd.description}</text>
          </box>
        )
      })}
    </box>
  )
}
