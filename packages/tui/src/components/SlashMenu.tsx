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
  { name: "/rewind", description: "Restore files and conversation to an earlier turn" },
  { name: "/fork", description: "Branch this session, optionally in a Git worktree" },
  { name: "/help", description: "Show help" },
  { name: "/login", description: "Log in to an OAuth provider (Grok / Codex)" },
  { name: "/onboard", description: "Open the first-run onboarding guide" },
  { name: "/model", description: "Pick or manage models (/model add|hide|restore|list)" },
  { name: "/skills", description: "Browse & run skills; add/remove/update repos" },
  { name: "/provider", description: "Configure available models for a provider" },
  { name: "/workers", description: "Inspect or tune automatic workflow model routing" },
  { name: "/scoreboard", description: "Model leaderboard by rating (`/scoreboard session` scopes it)" },
  { name: "/usage", description: "This session's tokens and cost, grouped by role" },
  { name: "/advisor", description: "Set the advisor model (a stronger model, on tap)" },
  { name: "/sidekick", description: "Configure sidekick seats (default + named, e.g. frontend/backend)" },
  { name: "/mode", description: "Named model+sidekick+advisor trios (/mode <name>, /mode save <name>)" },
  { name: "/incognito", description: "Go off the record: apply an incognito mode (/incognito [name])" },
  { name: "/goal", description: "Work autonomously toward a goal (/goal [--workflows] <objective>)" },
  { name: "/shipit", description: "Hand this plan off to a fresh goal-orchestrator session (/shipit [notes])" },
  { name: "/cacheguard", description: "Confirm before re-sending a big cold cache (/cacheguard 100k|off)" },
  { name: "/quit", description: "Exit Chunky CLI" },
]

export const builtinCommandNames = new Set(COMMANDS.map((c) => c.name.toLowerCase()))

/**
 * Saved modes double as slash commands: selecting `/fire` applies the "fire"
 * mode. Both entry points resolve them through here — the menu (App.onCommand,
 * which only sees built-in cases otherwise) and typed input (App.submit). Given
 * a bare `/command` and the current saved-mode commands, return the mode name to
 * hand to the `/mode <name>` apply flow (leading slash stripped), or null when
 * it's a built-in or unknown. Case-insensitive; never shadows a built-in.
 */
export function savedModeForCommand(command: string, slashModes: Command[]): string | null {
  const lower = command.toLowerCase()
  if (builtinCommandNames.has(lower)) return null
  const match = slashModes.find((m) => m.name.toLowerCase() === lower)
  return match ? match.name.replace(/^\//, "") : null
}

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
