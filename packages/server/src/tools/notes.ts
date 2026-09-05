import { tool } from "@langchain/core/tools"
import { z } from "zod"
import { Store } from "../store.ts"
import { busInstalled, emitToSession } from "../session-bus.ts"
import { sessionForThread } from "../thread-context.ts"

export const MAX_NOTE_BYTES = 64 * 1024
export const MAX_NOTES_PER_THREAD = 32
const PATH_PATTERN = /^[a-z0-9][a-z0-9/_.-]{0,79}$/

export const notesDescription = "Private working notes that survive context compaction. Use action=write/append to keep a concise running checkpoint as you work — goal, decisions, findings, why fixes failed, next steps, and recall seq numbers/turn numbers/keywords for evidence (e.g. 'recall seq_start=120 seq_end=140' or 'recall query: TypeError hydrate') — so nothing important is lost when older context is summarized (the summary is lossy; notes are re-injected verbatim). Update them when a <context_window_reminder> appears, then call compact_context to compact at a clean point. Use read/list/search to consult your notes or another thread's. Paths are virtual (default notes.md), not filesystem paths. Writes are limited to your own thread; owner reads another thread, while all_threads lists/searches every thread. Each thread may have 32 files of 64 KB each; start another file when one fills."

export const notesInputShape = {
  action: z.enum(["write", "append", "read", "list", "search"]),
  path: z.string().default("notes.md"),
  text: z.string().optional(),
  query: z.string().optional(),
  start_line: z.number().int().refine((value) => value !== 0, "start_line is 1-based and cannot be zero").optional(),
  end_line: z.number().int().refine((value) => value !== 0, "end_line is 1-based and cannot be zero").optional(),
  all_threads: z.boolean().default(false),
  owner: z.string().min(1).optional(),
}

type NotesInput = {
  action: "write" | "append" | "read" | "list" | "search"
  path?: string
  text?: string
  query?: string
  start_line?: number
  end_line?: number
  all_threads?: boolean
  owner?: string
}

const validPath = (path: string) => PATH_PATTERN.test(path) && !path.split("/").includes("..")
const lineCount = (text: string) => text ? text.split(/\r?\n/).length : 0
const ownerLabel = (sessionId: string, threadId: string) => threadId === sessionId ? "lead" : threadId
const age = (updatedAt: number) => {
  const seconds = Math.max(0, Math.floor((Date.now() - updatedAt) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  return hours < 48 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`
}
const resolveLine = (value: number | undefined, count: number, fallback: number) => {
  if (value === undefined) return fallback
  return value < 0 ? count + value + 1 : value
}

export async function runNotes(input: NotesInput, callerThreadId: string, sessionId: string): Promise<string> {
  const action = input.action
  const path = input.path ?? "notes.md"
  if (!validPath(path)) return "error: invalid notes path; use 1-80 lowercase letters, digits, /, _, ., or -, with no leading slash or '..' segment."
  if (input.owner && action !== "read") return "error: owner is only valid with action=read; writes are restricted to your own thread namespace."
  if (input.all_threads && action !== "list" && action !== "search") return "error: all_threads is only valid with action=list or action=search."

  if (action === "write" || action === "append") {
    if (input.text === undefined) return `error: text is required for action=${action}.`
    const prior = Store.getNote(sessionId, callerThreadId, path)
    if (prior === null && Store.listNotes(sessionId, callerThreadId).length >= MAX_NOTES_PER_THREAD) return `error: notes file limit reached (${MAX_NOTES_PER_THREAD}); update an existing file instead.`
    const next = action === "append" && prior ? `${prior}${prior.endsWith("\n") ? "" : "\n"}${input.text}` : input.text
    const bytes = Buffer.byteLength(next)
    if (bytes > MAX_NOTE_BYTES) return `error: note would be ${bytes} bytes; the maximum is ${MAX_NOTE_BYTES} bytes (64 KB). Start another notes file.`
    Store.putNote(sessionId, callerThreadId, path, next)
    const lines = lineCount(next)
    if (busInstalled()) emitToSession(sessionId, { type: "notes.update", sessionId, threadId: callerThreadId, path, lines, bytes, action })
    return `${action === "write" ? "Wrote" : "Appended"} ${path} (${lines} lines, ${bytes} bytes).`
  }

  if (action === "read") {
    const owner = input.owner ?? callerThreadId
    const text = Store.getNote(sessionId, owner, path)
    if (text === null) return `error: note not found: ${path} (owner: ${ownerLabel(sessionId, owner)}).`
    const lines = text ? text.split(/\r?\n/) : []
    let start = resolveLine(input.start_line, lines.length, 1)
    let end = resolveLine(input.end_line, lines.length, lines.length)
    start = Math.max(1, Math.min(lines.length || 1, start))
    end = Math.max(0, Math.min(lines.length, end))
    if (lines.length && end < start) return "error: end_line must resolve at or after start_line."
    return `# ${path} (${lines.length} lines, owner: ${ownerLabel(sessionId, owner)})\n${lines.slice(start - 1, end).join("\n")}`
  }

  if (action === "list") {
    const rows = Store.listNotes(sessionId, input.all_threads ? undefined : callerThreadId)
    if (!rows.length) return "No session notes."
    return rows.map((row) => `- ${row.path} (${row.lines} lines, ${row.bytes} bytes, owner: ${ownerLabel(sessionId, row.threadId)}, updated ${age(row.updatedAt)})`).join("\n")
  }

  if (!input.query?.trim()) return "error: query is required for action=search."
  const matches = Store.searchNotes(sessionId, input.all_threads ? undefined : callerThreadId, input.query).slice(0, 50)
  if (!matches.length) return `No notes matched ${JSON.stringify(input.query)}.`
  return matches.map((match) => `${input.all_threads ? `${ownerLabel(sessionId, match.threadId)}:` : ""}${match.path}:${match.line}: ${match.text}`).join("\n")
}

export const notes = tool(
  async (input: NotesInput, config?: unknown) => {
    const callerThreadId = (config as any)?.configurable?.thread_id as string | undefined
    const sessionId = sessionForThread(callerThreadId) ?? callerThreadId
    if (!callerThreadId || !sessionId) return "error: notes is only available inside an active session run."
    return runNotes(input, callerThreadId, sessionId)
  },
  { name: "notes", description: notesDescription, schema: z.object(notesInputShape) },
)
