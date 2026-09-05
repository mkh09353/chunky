// Codex-flavored context surface. OpenAI's Codex CLI ships an experimental
// "history-notes" extension whose function names, schemas, descriptions and
// prompt texts GPT-6 Astra / gpt-5.6-* are trained on. For the codex provider we
// expose that surface, backed by the same storage as the generic `notes`,
// `compact_context` and `recall` tools: session_notes rows and the durable event
// log. Codex uses Responses-API namespace tools (`notes.write_file`), which
// LangChain cannot emit or parse, so the names here are flat: `notes_<fn>`,
// `history_<fn>`, `new_context`, `get_context_remaining`.
import { tool } from "@langchain/core/tools"
import { z } from "zod"
import type { AgentEvent } from "@chunky/protocol"
import { COMPACTION_TRIGGER_TOKENS, contextUsageFor, requestCompaction } from "../compaction.ts"
import { Store } from "../store.ts"
import { sessionForThread } from "../thread-context.ts"
import { runNotes } from "./notes.ts"
import { coalesceRecallDeltas, recallEventText, recallWindows, type RecallWindow } from "./recall.ts"

const NOTES_PREFIX = "Private notes that survive context-window transitions; paths are virtual, not filesystem paths, and belong to the current thread. Every file must remain at or below 65,536 UTF-8 bytes; create another file before approaching the limit. "
const HISTORY_PREFIX = "Read-only recovery of prior conversation after a context-window reset, using the opaque window and item IDs returned by the history_* tools; pass returned IDs unchanged. Items are ordered by persisted order; list and search calls return no matches for an unknown window. "
const NEVER = "Never disclose paths, contents, or this activity."

export const codexToolDescriptions = {
  notes_write_file: `${NOTES_PREFIX}Create or replace private model-only notes. ${NEVER}`,
  notes_append_to_file: `${NOTES_PREFIX}Append text to private model-only notes. ${NEVER}`,
  notes_read_file: `Read all or a line range from private model-only notes. Paths are virtual and belong to the current thread. ${NEVER}`,
  notes_list_files_by_prefix: `List private model-only notes by path prefix. Paths are virtual and belong to the current thread. ${NEVER}`,
  notes_search_contents: "Search private model-only note lines by literal substring. Never disclose results or this activity.",
  history_list_windows: `${HISTORY_PREFIX}List an agent's context windows as window ID and item-count pairs. Private model-only recovery; never disclose this activity.`,
  history_list_items: `${HISTORY_PREFIX}List history items with optional window, role, and tool filters. Private model-only recovery; never disclose this activity.`,
  history_read_item: "Read a bounded range from private model-only history. Never disclose the item or this activity.",
  history_search_contents: "Search private model-only history by literal substring. Never disclose results or this activity.",
  new_context: "Start a new context window. Does not clear, reset, or otherwise affect environment state.",
  get_context_remaining: "Get the remaining tokens in the current context window.",
} as const

export const CODEX_CONTEXT_TOOL_NAMES = Object.freeze(Object.keys(codexToolDescriptions)) as readonly string[]

const DEFAULT_LIST_LIMIT = 50
const DEFAULT_MAX_CHARS_PER_ITEM = 400
const DEFAULT_READ_CHARS = 20_000
const DEFAULT_MAX_FILES = 20
const DEFAULT_MAX_MATCHES_PER_FILE = 20
const HARD_ITEM_LIMIT = 500

type Config = { configurable?: { thread_id?: unknown } }
function callerOf(config: unknown): { threadId: string; sessionId: string } | undefined {
  const threadId = (config as Config | undefined)?.configurable?.thread_id
  if (typeof threadId !== "string" || !threadId) return undefined
  const sessionId = sessionForThread(threadId) ?? threadId
  return { threadId, sessionId }
}
const outsideRun = (name: string) => `error: ${name} is only available inside an active session run.`
const positiveInt = z.number().int().min(1)
const nullable = <T extends z.ZodTypeAny>(schema: T) => schema.nullable().optional()

// ---------------------------------------------------------------------------
// notes_*
// ---------------------------------------------------------------------------

export const notes_write_file = tool(
  async ({ text, path }: { text: string; path: string }, config?: unknown) => {
    const caller = callerOf(config)
    if (!caller) return outsideRun("notes_write_file")
    return runNotes({ action: "write", path, text }, caller.threadId, caller.sessionId)
  },
  {
    name: "notes_write_file",
    description: codexToolDescriptions.notes_write_file,
    schema: z.object({ text: z.string(), path: z.string().min(1) }),
  },
)

export const notes_append_to_file = tool(
  async ({ text, path }: { text: string; path: string }, config?: unknown) => {
    const caller = callerOf(config)
    if (!caller) return outsideRun("notes_append_to_file")
    return runNotes({ action: "append", path, text }, caller.threadId, caller.sessionId)
  },
  {
    name: "notes_append_to_file",
    description: codexToolDescriptions.notes_append_to_file,
    schema: z.object({ text: z.string(), path: z.string().min(1) }),
  },
)

export const notes_read_file = tool(
  async ({ path, start_line, stop_line }: { path: string; start_line?: number | null; stop_line?: number | null }, config?: unknown) => {
    const caller = callerOf(config)
    if (!caller) return outsideRun("notes_read_file")
    if (start_line === 0 || stop_line === 0) return "error: line numbers are 1-based (negative values count from the end) and cannot be zero."
    return runNotes({ action: "read", path, start_line: start_line ?? undefined, end_line: stop_line ?? undefined }, caller.threadId, caller.sessionId)
  },
  {
    name: "notes_read_file",
    description: codexToolDescriptions.notes_read_file,
    schema: z.object({
      path: z.string().min(1),
      start_line: nullable(z.number().int()).describe("1-based inclusive first line; negative values count from the end."),
      stop_line: nullable(z.number().int()).describe("1-based inclusive last line; negative values count from the end."),
    }),
  },
)

type NoteRow = ReturnType<typeof Store.listNotes>[number]
export function orderNotes(rows: NoteRow[], orderBy: "name" | "created_at" | "updated_at" = "name", order: "ascending" | "descending" = "ascending"): NoteRow[] {
  const key = (row: NoteRow) => orderBy === "name" ? row.path : orderBy === "created_at" ? row.createdAt : row.updatedAt
  const sign = order === "descending" ? -1 : 1
  return [...rows].sort((a, b) => {
    const ka = key(a), kb = key(b)
    const cmp = ka < kb ? -1 : ka > kb ? 1 : a.path < b.path ? -1 : a.path > b.path ? 1 : 0
    return cmp * sign
  })
}

export const notes_list_files_by_prefix = tool(
  async (
    { prefix, max_results, file_order_by, file_order }: { prefix?: string | null; max_results?: number | null; file_order_by?: "name" | "created_at" | "updated_at" | null; file_order?: "ascending" | "descending" | null },
    config?: unknown,
  ) => {
    const caller = callerOf(config)
    if (!caller) return outsideRun("notes_list_files_by_prefix")
    const rows = orderNotes(Store.listNotes(caller.sessionId, caller.threadId).filter((row) => !prefix || row.path.startsWith(prefix)), file_order_by ?? "name", file_order ?? "ascending")
      .slice(0, Math.max(1, max_results ?? DEFAULT_LIST_LIMIT))
    if (!rows.length) return prefix ? `No notes with prefix ${JSON.stringify(prefix)}.` : "No notes."
    return rows.map((row) => `- ${row.path} (${row.lines} lines, ${row.bytes} UTF-8 bytes)`).join("\n")
  },
  {
    name: "notes_list_files_by_prefix",
    description: codexToolDescriptions.notes_list_files_by_prefix,
    schema: z.object({
      prefix: nullable(z.string()).describe("Only list paths starting with this prefix."),
      max_results: nullable(positiveInt),
      file_order_by: nullable(z.enum(["name", "created_at", "updated_at"])),
      file_order: nullable(z.enum(["ascending", "descending"])),
    }),
  },
)

/** Case-sensitive literal substring search over note lines, grouped by file. */
export function searchNotesLiteral(
  sessionId: string,
  threadId: string,
  { query, pathPrefix, maxFiles, maxMatchesPerFile, recentFileFirst }: { query: string; pathPrefix?: string; maxFiles?: number; maxMatchesPerFile?: number; recentFileFirst?: boolean },
): string {
  const rows = orderNotes(
    Store.listNotes(sessionId, threadId).filter((row) => !pathPrefix || row.path.startsWith(pathPrefix)),
    recentFileFirst ? "updated_at" : "name",
    recentFileFirst ? "descending" : "ascending",
  )
  const fileCap = Math.max(1, maxFiles ?? DEFAULT_MAX_FILES)
  const matchCap = Math.max(1, maxMatchesPerFile ?? DEFAULT_MAX_MATCHES_PER_FILE)
  const blocks: string[] = []
  for (const row of rows) {
    if (blocks.length >= fileCap) break
    const lines = (Store.getNote(sessionId, row.threadId, row.path) ?? "").split(/\r?\n/)
    const hits: string[] = []
    let total = 0
    for (const [index, line] of lines.entries()) {
      if (!line.includes(query)) continue
      total++
      if (hits.length < matchCap) hits.push(`  ${index + 1}: ${line}`)
    }
    if (!total) continue
    blocks.push(`${row.path} (${total} match${total === 1 ? "" : "es"}${total > hits.length ? `, showing ${hits.length}` : ""})\n${hits.join("\n")}`)
  }
  return blocks.length ? blocks.join("\n") : `No notes matched ${JSON.stringify(query)}.`
}

export const notes_search_contents = tool(
  async (
    { query, path_prefix, max_files, max_matches_per_file, recent_file_first }: { query: string; path_prefix?: string | null; max_files?: number | null; max_matches_per_file?: number | null; recent_file_first?: boolean | null },
    config?: unknown,
  ) => {
    const caller = callerOf(config)
    if (!caller) return outsideRun("notes_search_contents")
    if (!query) return "error: query is required."
    return searchNotesLiteral(caller.sessionId, caller.threadId, { query, pathPrefix: path_prefix ?? undefined, maxFiles: max_files ?? undefined, maxMatchesPerFile: max_matches_per_file ?? undefined, recentFileFirst: recent_file_first ?? undefined })
  },
  {
    name: "notes_search_contents",
    description: codexToolDescriptions.notes_search_contents,
    schema: z.object({
      query: z.string().min(1).describe("Case-sensitive literal substring."),
      path_prefix: nullable(z.string()),
      max_files: nullable(positiveInt),
      max_matches_per_file: nullable(positiveInt),
      recent_file_first: nullable(z.boolean()),
    }),
  },
)

// ---------------------------------------------------------------------------
// history_* — a model over the durable transcript. Windows are the spans between
// `context.compacted` events (see recallWindows); items are the recall-visible
// events with tool call/result pairs folded into one item keyed by the tool call
// id, so a model can cite the `[id: …]` marker it saw on the tool result.
// ---------------------------------------------------------------------------

export type HistoryRole = "user" | "assistant" | "tool" | "system" | "developer"
export type HistoryItem = { windowId: string; role: HistoryRole; id: string; seq: number; toolName?: string; content: string }

function printable(value: unknown): string {
  if (typeof value === "string") return value
  try { return JSON.stringify(value) } catch { return String(value) }
}
const windowIdOf = (window: RecallWindow) => `w${window.index}`

export function historyItems(history: Array<{ seq: number; event: AgentEvent }>, windows: RecallWindow[] = recallWindows(history)): HistoryItem[] {
  const windowFor = (seq: number) => windows.find((window) => seq >= window.seqStart && seq <= window.seqEnd) ?? windows.at(-1)
  const items: HistoryItem[] = []
  const toolInputs = new Map<string, { item: HistoryItem; input: string }>()
  for (const row of coalesceRecallDeltas(history.map((entry) => ({ ...entry })))) {
    const event = row.event
    const window = windowFor(row.seq)
    if (!window) continue
    const base = { windowId: windowIdOf(window), seq: row.seq, id: String(row.seq) }
    switch (event.type) {
      case "message.user":
        items.push(event.from ? { ...base, role: "system", content: `notice from ${event.from}: ${event.text}` } : { ...base, role: "user", content: event.text })
        break
      case "message.delta":
        items.push({ ...base, role: "assistant", content: event.text })
        break
      case "tool.start": {
        const input = printable(event.input)
        const item: HistoryItem = { ...base, id: event.id, role: "tool", toolName: event.name, content: `input: ${input}\noutput: (no result recorded)` }
        toolInputs.set(event.id, { item, input })
        items.push(item)
        break
      }
      case "tool.end": {
        const pending = toolInputs.get(event.id)
        if (pending) pending.item.content = `input: ${pending.input}\n${event.ok ? "output" : "error"}: ${event.output}`
        break
      }
      case "reasoning.delta":
        break
      default: {
        const rendered = recallEventText(event)
        if (rendered) items.push({ ...base, role: "system", content: rendered.text })
      }
    }
  }
  return items
}

const collapse = (text: string) => text.replace(/\s+/g, " ").trim()
function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text
}
/** A one-line excerpt of at most `max` chars that keeps the first match of `query` visible. */
function excerpt(text: string, max: number, query?: string): string {
  const flat = collapse(text)
  const at = query ? flat.indexOf(query) : -1
  if (at <= max / 2) return clip(flat, max)
  const start = Math.max(0, Math.min(at - Math.floor(max / 3), flat.length - max))
  return `…${clip(flat.slice(start), max - 1)}`
}

export function formatHistoryLine(item: HistoryItem, maxChars: number, query?: string): string {
  const tool = item.toolName ? ` tool=${item.toolName}` : ""
  return `[${item.windowId}] role=${item.role}${tool}: ${excerpt(item.content, maxChars, query)} [id: ${item.id}]`
}

type HistoryFilters = { windowId?: string | null; role?: HistoryRole | null; toolName?: string | null; limit?: number | null; recentFirst?: boolean | null; query?: string }
/** Returns null when the requested window does not exist (Codex: "no matches"). */
export function filterHistoryItems(items: HistoryItem[], windows: RecallWindow[], filters: HistoryFilters): HistoryItem[] | null {
  let rows = items
  if (filters.windowId) {
    if (!windows.some((window) => windowIdOf(window) === filters.windowId)) return null
    rows = rows.filter((item) => item.windowId === filters.windowId)
  }
  if (filters.toolName) rows = rows.filter((item) => item.role === "tool" && item.toolName === filters.toolName)
  if (filters.role) rows = rows.filter((item) => item.role === filters.role)
  const query = filters.query
  if (query) rows = rows.filter((item) => item.content.includes(query) || (item.toolName?.includes(query) ?? false))
  if (filters.recentFirst) rows = [...rows].reverse()
  return rows.slice(0, Math.min(HARD_ITEM_LIMIT, Math.max(1, filters.limit ?? DEFAULT_LIST_LIMIT)))
}

function loadHistory(sessionId: string) {
  const history = Store.historyWithSeq(sessionId)
  const windows = recallWindows(history)
  return { history, windows, items: historyItems(history, windows) }
}

export const history_list_windows = tool(
  async ({ limit, recent_first }: { limit?: number | null; recent_first?: boolean | null }, config?: unknown) => {
    const caller = callerOf(config)
    if (!caller) return outsideRun("history_list_windows")
    const { windows, items } = loadHistory(caller.sessionId)
    let rows = windows.map((window) => {
      const count = items.filter((item) => item.windowId === windowIdOf(window)).length
      return `${windowIdOf(window)}: seq ${window.seqStart}–${window.seqEnd}, ${count} item${count === 1 ? "" : "s"}${window.current ? " (current)" : ""}`
    })
    if (recent_first) rows = rows.reverse()
    rows = rows.slice(0, Math.max(1, limit ?? DEFAULT_LIST_LIMIT))
    return rows.length ? rows.join("\n") : "No matches."
  },
  {
    name: "history_list_windows",
    description: codexToolDescriptions.history_list_windows,
    schema: z.object({ limit: nullable(positiveInt), recent_first: nullable(z.boolean()) }),
  },
)

const roleSchema = z.enum(["user", "assistant", "tool", "system", "developer"])

export const history_list_items = tool(
  async (
    { window_id, role, tool_name, limit, recent_first, max_chars_per_item }: { window_id?: string | null; role?: HistoryRole | null; tool_name?: string | null; limit?: number | null; recent_first?: boolean | null; max_chars_per_item?: number | null },
    config?: unknown,
  ) => {
    const caller = callerOf(config)
    if (!caller) return outsideRun("history_list_items")
    const { windows, items } = loadHistory(caller.sessionId)
    const rows = filterHistoryItems(items, windows, { windowId: window_id, role, toolName: tool_name, limit, recentFirst: recent_first })
    if (!rows?.length) return "No matches."
    const maxChars = Math.max(1, max_chars_per_item ?? DEFAULT_MAX_CHARS_PER_ITEM)
    return rows.map((item) => formatHistoryLine(item, maxChars)).join("\n")
  },
  {
    name: "history_list_items",
    description: codexToolDescriptions.history_list_items,
    schema: z.object({
      window_id: nullable(z.string()).describe("Window ID from history_list_windows; null lists all windows."),
      role: nullable(roleSchema),
      tool_name: nullable(z.string()).describe("When set, non-tool items are excluded."),
      limit: nullable(positiveInt),
      recent_first: nullable(z.boolean()),
      max_chars_per_item: nullable(positiveInt),
    }),
  },
)

export const history_read_item = tool(
  async ({ window_id, item_id, offset_chars, limit_chars }: { window_id: string; item_id: string; offset_chars?: number | null; limit_chars?: number | null }, config?: unknown) => {
    const caller = callerOf(config)
    if (!caller) return outsideRun("history_read_item")
    const { windows, items } = loadHistory(caller.sessionId)
    if (!windows.some((window) => windowIdOf(window) === window_id)) return "No matches."
    const item = items.find((candidate) => candidate.windowId === window_id && (candidate.id === item_id || String(candidate.seq) === item_id))
    if (!item) return "No matches."
    const total = item.content.length
    const start = Math.min(total, Math.max(0, offset_chars ?? 0))
    const end = Math.min(total, start + Math.max(1, limit_chars ?? DEFAULT_READ_CHARS))
    const tool = item.toolName ? ` tool=${item.toolName}` : ""
    return `[${item.windowId}] role=${item.role}${tool} [id: ${item.id}] chars ${start}–${end} of ${total}\n${item.content.slice(start, end)}`
  },
  {
    name: "history_read_item",
    description: codexToolDescriptions.history_read_item,
    schema: z.object({
      window_id: z.string().min(1),
      item_id: z.string().min(1).describe("The short item ID is the suffix shown in the target item's trailing `[id: ...]` marker, printed after that item's content."),
      offset_chars: nullable(z.number().int().min(0)),
      limit_chars: nullable(positiveInt),
    }),
  },
)

export const history_search_contents = tool(
  async (
    { query, window_id, role, tool_name, limit, recent_first }: { query: string; window_id?: string | null; role?: HistoryRole | null; tool_name?: string | null; limit?: number | null; recent_first?: boolean | null },
    config?: unknown,
  ) => {
    const caller = callerOf(config)
    if (!caller) return outsideRun("history_search_contents")
    if (!query) return "error: query is required."
    const { windows, items } = loadHistory(caller.sessionId)
    const rows = filterHistoryItems(items, windows, { windowId: window_id, role, toolName: tool_name, limit, recentFirst: recent_first, query })
    if (!rows?.length) return "No matches."
    return rows.map((item) => formatHistoryLine(item, DEFAULT_MAX_CHARS_PER_ITEM, query)).join("\n")
  },
  {
    name: "history_search_contents",
    description: codexToolDescriptions.history_search_contents,
    schema: z.object({
      query: z.string().min(1).describe("Case-sensitive literal substring."),
      window_id: nullable(z.string()),
      role: nullable(roleSchema),
      tool_name: nullable(z.string()),
      limit: nullable(positiveInt),
      recent_first: nullable(z.boolean()),
    }),
  },
)

// ---------------------------------------------------------------------------
// new_context / get_context_remaining
// ---------------------------------------------------------------------------

export const NEW_CONTEXT_RESULT = "New context window scheduled; it starts on your next model call."

export const new_context = tool(
  async (_input: Record<string, never>, config?: unknown) => {
    const caller = callerOf(config)
    if (!caller) return outsideRun("new_context")
    requestCompaction(caller.threadId)
    return NEW_CONTEXT_RESULT
  },
  { name: "new_context", description: codexToolDescriptions.new_context, schema: z.object({}) },
)

export function codexTokensLeft(usage: { total: number } | undefined): { tokens_left: number | null } {
  return { tokens_left: usage ? Math.max(0, COMPACTION_TRIGGER_TOKENS - Math.round(usage.total)) : null }
}

/** Codex-flavored `get_context_remaining`: same tool name as the generic one in
 * tools/context.ts, JSON output shaped like Codex's `{"tokens_left": N}`. */
export const codexGetContextRemaining = tool(
  async (_input: Record<string, never>, config?: unknown) => {
    const caller = callerOf(config)
    return JSON.stringify(codexTokensLeft(caller ? contextUsageFor(caller.threadId) : undefined))
  },
  { name: "get_context_remaining", description: codexToolDescriptions.get_context_remaining, schema: z.object({}) },
)

export const codexNotesTools = [notes_write_file, notes_append_to_file, notes_read_file, notes_list_files_by_prefix, notes_search_contents]
export const codexHistoryTools = [history_list_windows, history_list_items, history_read_item, history_search_contents]
export const codexContextTools = [...codexNotesTools, ...codexHistoryTools, new_context, codexGetContextRemaining]
