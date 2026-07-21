// Slash commands for the app composer. The composer's `/` trigger menu inserts
// a command's text; on submit App.tsx routes anything matching a KNOWN command
// here instead of sending it as a chat message. Unknown `/foo` text still goes
// to the model — only names listed below are intercepted.
import type { GoalMode } from "@chunky/protocol"

export interface SlashCommand {
  name: string
  description: string
  /** Text inserted when picked from the menu (trailing space = takes args). */
  insert: string
}

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: "/goal",
    description: "Work autonomously toward a goal (--workflows to orchestrate, --turns N for a budget)",
    insert: "/goal ",
  },
  {
    name: "/shipit",
    description: "Hand this plan off to a fresh goal-orchestrator session (optional notes)",
    insert: "/shipit ",
  },
  {
    name: "/resume",
    description: "Resume another thread in this repo (optional title filter; blank = most recent)",
    insert: "/resume ",
  },
  {
    name: "/clear",
    description: "Start a new thread in this repo",
    insert: "/clear",
  },
  {
    name: "/model",
    description: "Open the model picker (same as the composer's model button)",
    insert: "/model",
  },
  {
    name: "/skills",
    description: "Browse skills (bare) · list · add <url> · remove <id> · update [id]",
    insert: "/skills",
  },
  {
    name: "/advisor",
    description: "Set the always-on advisor model (a second opinion the executor consults)",
    insert: "/advisor",
  },
  {
    name: "/mode",
    description: "Named model+advisor pairings: /mode <name> applies, save <name>, rm <name>",
    insert: "/mode ",
  },
  {
    name: "/incognito",
    description: "Go off the record: apply an incognito mode (bare picks it, /incognito <name> names one)",
    insert: "/incognito ",
  },
  {
    name: "/login",
    description: "Log in to a provider (/login lists them, /login <provider> starts the flow)",
    insert: "/login ",
  },
  { name: "/onboard", description: "Open the onboarding guide", insert: "/onboard" },
  {
    name: "/theme",
    description: "Appearance: /theme system|light|dark (bare cycles through them)",
    insert: "/theme ",
  },
  {
    name: "/cacheguard",
    description: "Confirm-before-resend threshold for cold caches (/cacheguard <tokens|off>)",
    insert: "/cacheguard ",
  },
  {
    name: "/scoreboard",
    description: "Model leaderboard by rating (`/scoreboard session` scopes it to this thread)",
    insert: "/scoreboard",
  },
  {
    name: "/usage",
    description: "This thread's tokens and cost, grouped by role",
    insert: "/usage",
  },
  {
    name: "/help",
    description: "List the available commands",
    insert: "/help",
  },
]

/** Split a submitted message into a KNOWN command + its argument string, or null
 *  so ordinary messages (including unknown `/foo` text) go to the model. */
export function parseSlashCommand(text: string): { name: string; rest: string } | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith("/")) return null
  const space = trimmed.indexOf(" ")
  const name = space === -1 ? trimmed : trimmed.slice(0, space)
  if (!SLASH_COMMANDS.some((c) => c.name === name)) return null
  return { name, rest: space === -1 ? "" : trimmed.slice(space + 1).trim() }
}

export type GoalIntent =
  | { kind: "status" }
  | { kind: "action"; action: "pause" | "resume" | "clear" }
  | { kind: "set"; objective: string; maxTurns?: number; mode?: GoalMode }

/** Parse `/goal ...` arguments — mirrors the server's parseGoalCommand: bare →
 *  status, lifecycle words, else an objective with optional leading `--turns N`
 *  and `--workflows` (alias `--dynamite`) flags in either order. */
export function parseGoalArgs(rest: string): GoalIntent {
  const trimmed = rest.trim()
  if (!trimmed) return { kind: "status" }
  const lower = trimmed.toLowerCase()
  if (lower === "pause") return { kind: "action", action: "pause" }
  if (lower === "resume" || lower === "continue") return { kind: "action", action: "resume" }
  if (lower === "clear" || lower === "stop" || lower === "cancel") return { kind: "action", action: "clear" }

  let objective = trimmed
  let maxTurns: number | undefined
  let mode: GoalMode | undefined
  for (;;) {
    const turns = objective.match(/^--turns\s+(\d+)\s+([\s\S]+)$/)
    if (turns) {
      maxTurns = Number(turns[1])
      objective = turns[2]!.trim()
      continue
    }
    const workflows = objective.match(/^--(?:workflows|dynamite)\s+([\s\S]+)$/)
    if (workflows) {
      mode = "workflows"
      objective = workflows[1]!.trim()
      continue
    }
    break
  }
  return { kind: "set", objective, maxTurns, mode }
}
