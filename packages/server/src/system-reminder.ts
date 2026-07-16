export interface ReminderGoal {
  objective: string
  status: string
  mode: string
  turns: number
  maxTurns: number
}
export interface ReminderTask { taskId: string; status: string; command: string }
export interface ReminderSidekick { seat: string; brief: string }
export interface ReminderChild { threadId: string; title: string }
export interface LiveSessionState {
  goal?: ReminderGoal
  sidekicks?: ReminderSidekick[]
  children?: ReminderChild[]
  tasks?: ReminderTask[]
}

const oneLine = (value: string, max = 140) => {
  const text = value.replace(/\s+/g, " ").trim()
  return text.length > max ? text.slice(0, max - 1) + "…" : text
}
const safe = (value: string, max?: number) => oneLine(value, max).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

/** Pure live-state rendering. Callers own collection and session identity. */
export function formatSystemReminder(state: LiveSessionState): string | null {
  const lines: string[] = []
  if (state.goal) {
    const g = state.goal
    lines.push("## Active Goal", `status: ${safe(g.status)} | mode: ${safe(g.mode)} | turn ${g.turns}/${g.maxTurns}`, `<untrusted_objective>${safe(g.objective, 500)}</untrusted_objective>`)
  }
  if (state.sidekicks?.length) lines.push("## Active Sidekicks", ...state.sidekicks.map((s) => `- ${safe(s.seat)} — ${safe(s.brief)}`))
  if (state.children?.length) lines.push("## Running Child Threads", ...state.children.map((c) => `- ${safe(c.threadId, 80)} — ${safe(c.title)}`))
  if (state.tasks?.length) lines.push("## Background Tasks", ...state.tasks.map((t) => `- ${safe(t.taskId, 80)} (${safe(t.status)}) — ${safe(t.command)}`))
  if (!lines.length) return null
  return `<system-reminder>\n${lines.slice(0, 38).join("\n")}\n</system-reminder>`
}
