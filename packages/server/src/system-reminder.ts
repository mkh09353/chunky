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
export interface ReminderDetachedSpawn { id: string; title: string; status: string }
export interface ReminderTodo { id: string; content: string; status: string; assignee?: string }
export interface ReminderEditedFile { path: string }
export interface ReminderNote { path: string; lines: number; bytes: number; text?: string }
export interface LiveSessionState {
  goal?: ReminderGoal
  sidekicks?: ReminderSidekick[]
  children?: ReminderChild[]
  detachedSpawns?: ReminderDetachedSpawn[]
  tasks?: ReminderTask[]
  todos?: ReminderTodo[]
  editedFiles?: ReminderEditedFile[]
  notes?: ReminderNote[]
}

export const NOTES_REMINDER_CHAR_BUDGET = 24_000
export const CONTEXT_WINDOW_RECENT_NOTES = 5

export interface ContextWindowBlock {
  agentName: string
  /** 1-based index of the current window (count of persisted context.compacted events + 1). */
  current: number
  /** Present only after a reset; the window the compaction just closed. */
  previous?: number
  /** The thread's notes, most-recently-updated first; only the first 5 are listed. */
  notes: ReminderNote[]
}

/** Codex's `<context_window>` developer block, emitted at the start of a fresh
 * codex-mode thread and after every reset. Lists note metadata only: the model
 * reads note contents itself with notes_read_file (Codex-faithful). */
export function formatContextWindowBlock(block: ContextWindowBlock): string {
  const lines = [
    "<context_window>",
    `Agent name: ${block.agentName}`,
    "First context window id: w1",
    `Current context window id: w${block.current}`,
    ...(block.previous != null ? [`Previous context window id: w${block.previous}`] : []),
    `Recent notes (up to ${CONTEXT_WINDOW_RECENT_NOTES}, most-recent first):`,
    ...(block.notes.length ? block.notes.slice(0, CONTEXT_WINDOW_RECENT_NOTES).map((note) => `- ${note.path} (${note.lines} lines, ${note.bytes} UTF-8 bytes)`) : ["No notes."]),
    "</context_window>",
  ]
  return lines.join("\n")
}

const oneLine = (value: string, max = 140) => {
  const text = value.replace(/\s+/g, " ").trim()
  return text.length > max ? text.slice(0, max - 1) + "…" : text
}
const safe = (value: string, max?: number) => oneLine(value, max).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

function formatNotes(notes: ReminderNote[]): string[] {
  if (!notes.length) return []
  const lines = ["## Session Notes (persist across compaction; maintain with the notes tool)"]
  let remaining = NOTES_REMINDER_CHAR_BUDGET
  for (const note of notes) {
    if (note.text !== undefined && note.text.length <= remaining) {
      lines.push(`### ${note.path} (${note.lines} lines, ${note.bytes} bytes)`, note.text)
      remaining -= note.text.length
    } else {
      lines.push(`- ${note.path} (${note.lines} lines, ${note.bytes} bytes) — notes action=read`)
    }
  }
  return lines
}

/** Pure live-state rendering. Callers own collection and session identity. */
export function formatSystemReminder(state: LiveSessionState): string | null {
  const lines: string[] = []
  if (state.goal) {
    const g = state.goal
    lines.push("## Active Goal", `status: ${safe(g.status)} | mode: ${safe(g.mode)} | turn ${g.turns}/${g.maxTurns}`, `<untrusted_objective>${safe(g.objective, 500)}</untrusted_objective>`)
  }
  if (state.todos?.length) lines.push("## Session Todos", ...state.todos.map((t) => `- ${safe(t.status)} — ${safe(t.content)}${t.assignee ? ` [${safe(t.assignee)}]` : ""}`))
  if (state.sidekicks?.length) lines.push("## Active Sidekicks", ...state.sidekicks.map((s) => `- ${safe(s.seat)} — ${safe(s.brief)}`))
  if (state.children?.length) lines.push("## Running Child Threads", ...state.children.map((c) => `- ${safe(c.threadId, 80)} — ${safe(c.title)}`))
  if (state.detachedSpawns?.length) lines.push("## Detached Child Threads", ...state.detachedSpawns.map((c) => `- ${safe(c.id, 80)} (${safe(c.status)}) — ${safe(c.title)}`))
  if (state.tasks?.length) lines.push("## Background Tasks", ...state.tasks.map((t) => `- ${safe(t.taskId, 80)} (${safe(t.status)}) — ${safe(t.command)}`))
  if (state.editedFiles?.length) lines.push("## Files edited this session:", ...state.editedFiles.map((f) => `- ${safe(f.path, 500)}`))
  const notes = formatNotes(state.notes ?? [])
  if (!lines.length && !notes.length) return null
  return `<system-reminder>\n${[...lines.slice(0, 38), ...notes].join("\n")}\n</system-reminder>`
}
