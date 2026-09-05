// Durable transcript recall. LangGraph compaction summarizes checkpoint state, but
// the session event log remains append-only; this tool reads that log only.
import { tool } from "@langchain/core/tools"
import { z } from "zod"
import type { AgentEvent } from "@chunky/protocol"
import { Store } from "../store.ts"
import { sessionForThread } from "../thread-context.ts"

export const MAX_LINES = 1200
export const MAX_BYTES = 40_000
export const SEARCH_EVENT_MAX = 500
export const RANGE_EVENT_MAX = 4_000
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

/** A logical transcript item. A delta run retains its inclusive persisted seq
 * span so a range can select it even where the requested start falls mid-run. */
export type TranscriptRow = { seq: number; event: AgentEvent; endSeq?: number }

function shorten(text: string, max: number): string {
  const clean = text.replace(/\r/g, "").trim()
  return clean.length > max ? clean.slice(0, max - 1) + "…" : clean
}

function printable(value: unknown): string {
  if (typeof value === "string") return value
  try { return JSON.stringify(value) } catch { return String(value) }
}

/** Extract the useful model/user/tool text from one persisted wire event. UI-only
 * state changes deliberately return null so recall reads like a transcript. */
export function recallEventText(event: AgentEvent): { speaker: string; text: string } | null {
  switch (event.type) {
    case "message.user":
      return { speaker: event.from ? `user from ${event.from}` : "user", text: event.text }
    case "message.delta":
      return { speaker: "assistant", text: event.text }
    case "reasoning.delta":
      return { speaker: "reasoning", text: event.text }
    case "tool.start":
      return { speaker: `tool ${event.name}`, text: `input: ${printable(event.input)}` }
    case "tool.end":
      return { speaker: "tool", text: `${event.ok ? "output" : "error"}: ${event.output}` }
    case "error":
      return { speaker: "error", text: event.message }
    case "goal.update":
      return event.message ? { speaker: "goal", text: event.message } : null
    case "workflow.phase":
      return { speaker: "workflow", text: event.title }
    case "workflow.log":
      return { speaker: "workflow", text: event.message }
    case "context.compacted":
      return { speaker: "system", text: "Context compacted — older messages summarized." }
    case "notes.update":
      return { speaker: "notes", text: `${event.action}: ${event.path} (${event.lines} lines, ${event.bytes} bytes)` }
    default:
      return null
  }
}

function isDelta(row: TranscriptRow): row is TranscriptRow & { event: Extract<AgentEvent, { type: "message.delta" | "reasoning.delta" }> } {
  return row.event.type === "message.delta" || row.event.type === "reasoning.delta"
}

/** Streaming deltas are persisted fragment-by-fragment. Collapse only adjacent
 * same-kind runs from the same thread: start/end/tool events intentionally break
 * a run, and child-thread output can never be joined to its parent. */
export function coalesceRecallDeltas(rows: TranscriptRow[]): TranscriptRow[] {
  const result: TranscriptRow[] = []
  for (const row of rows) {
    const previous = result.at(-1)
    if (
      previous && isDelta(previous) && isDelta(row) &&
      previous.event.type === row.event.type &&
      previous.event.threadId === row.event.threadId
    ) {
      previous.event = { ...previous.event, text: previous.event.text + row.event.text }
      previous.endSeq = row.endSeq ?? row.seq
    } else {
      result.push({ ...row })
    }
  }
  return result
}

/** Format rows as model-readable transcript lines. Search mode intentionally
 * keeps each event short; range reads preserve substantially more detail. */
export function renderRecallEvents(rows: TranscriptRow[], searchMode: boolean): string {
  const perEventMax = searchMode ? SEARCH_EVENT_MAX : RANGE_EVENT_MAX
  const lines: string[] = []
  let bytes = 0
  for (const row of rows) {
    const rendered = recallEventText(row.event)
    if (!rendered) continue
    const seq = row.endSeq != null && row.endSeq !== row.seq ? `${row.seq}-${row.endSeq}` : String(row.seq)
    const line = `[${seq} ${rendered.speaker}] ${shorten(rendered.text, perEventMax)}`
    if (lines.length >= MAX_LINES || bytes + line.length + 1 > MAX_BYTES) {
      lines.push("[output capped — use narrower query or seq range]")
      break
    }
    lines.push(line)
    bytes += line.length + 1
  }
  return lines.length ? lines.join("\n") : "No readable transcript events matched."
}

/** A context window is the span of durable events between consecutive
 * `context.compacted` markers; the marker closes the window it ends. Window 1
 * starts at the first event; the last window (after the final compaction, or the
 * only window when nothing was compacted) is the current one. */
export type RecallWindow = { index: number; seqStart: number; seqEnd: number; current: boolean }

export function recallWindows(history: Array<{ seq: number; event: AgentEvent }>): RecallWindow[] {
  const compactSeqs = history.flatMap((row) => row.event.type === "context.compacted" ? [row.seq] : [])
  const firstSeq = history[0]?.seq ?? 0
  const lastSeq = history.at(-1)?.seq ?? firstSeq
  const starts = [firstSeq, ...compactSeqs.map((seq) => seq + 1)]
  const ends = [...compactSeqs, lastSeq]
  return starts.map((seqStart, i) => ({ index: i + 1, seqStart, seqEnd: Math.max(seqStart, ends[i]!), current: i === starts.length - 1 }))
}

/** Positive `window` counts from the first window; negative counts from the end
 * (-1 = current, -2 = the window before the latest compaction). */
export function resolveRecallWindow(windows: RecallWindow[], window: number): RecallWindow | undefined {
  if (!Number.isInteger(window) || window === 0) return undefined
  return window > 0 ? windows[window - 1] : windows[windows.length + window]
}

export function describeRecallWindows(
  history: Array<{ seq: number; event: AgentEvent }>,
  turns: Array<{ turnIndex: number; startEventSeq: number }>,
  windows: RecallWindow[] = recallWindows(history),
): string {
  return windows.map((window) => {
    const rows = history.filter((row) => row.seq >= window.seqStart && row.seq <= window.seqEnd)
    const toolCalls = rows.filter((row) => row.event.type === "tool.start").length
    const turnIndexes = turns.filter((turn) => turn.startEventSeq >= window.seqStart && turn.startEventSeq <= window.seqEnd).map((turn) => turn.turnIndex)
    const turnText = !turnIndexes.length ? "no turns" : turnIndexes.length === 1 ? `turn ${turnIndexes[0]}` : `turns ${Math.min(...turnIndexes)}–${Math.max(...turnIndexes)}`
    const firstUser = rows.find((row) => row.event.type === "message.user" && !row.event.from)
    const firstText = firstUser?.event.type === "message.user" ? JSON.stringify(shorten(firstUser.event.text, 80)) : "(none)"
    return `window ${window.index}${window.current ? " (current)" : ""}: seq ${window.seqStart}–${window.seqEnd}, ${turnText}, ${rows.length} events, ${toolCalls} tool calls, first user message: ${firstText}`
  }).join("\n")
}

export function recallMatcher(query: string): (text: string) => boolean {
  // Regex-lite: accept a normal JS regexp when valid, otherwise treat the query
  // literally. Reset lastIndex makes global/sticky patterns deterministic.
  try {
    const re = new RegExp(query, "i")
    return (text) => { re.lastIndex = 0; return re.test(text) }
  } catch {
    const needle = query.toLowerCase()
    return (text) => text.toLowerCase().includes(needle)
  }
}

/** Coalesce first, then apply range and query predicates to the logical rows.
 * A seq range intersects a delta span rather than dropping a response merely
 * because its first fragment precedes the requested starting sequence. */
export function filterRecallEvents(
  source: TranscriptRow[],
  { query, seqStart, seqEnd, tool, speaker, turnStart, turnEnd, beforeSeq }: { query?: string; seqStart?: number; seqEnd?: number; tool?: string; speaker?: string; turnStart?: number; turnEnd?: number; beforeSeq?: number },
): TranscriptRow[] {
  let rows = coalesceRecallDeltas(source)
  if (beforeSeq != null) rows = rows.filter((row) => row.seq < beforeSeq)
  if (tool) {
    const starts = source.flatMap((x) => x.event.type === "tool.start" ? [{ id: x.event.id, name: x.event.name }] : [])
    const names = new Map(starts.map((x) => [x.id, x.name]))
    rows = rows.filter((row) => row.event.type === "tool.start" ? row.event.name === tool : row.event.type === "tool.end" && names.get(row.event.id) === tool)
  }
  if (speaker) rows = rows.filter((row) => { const r = recallEventText(row.event); return r?.speaker === speaker || (speaker === "tool" && r?.speaker.startsWith("tool ")) })
  if (seqStart != null) rows = rows.filter((row) => (row.endSeq ?? row.seq) >= seqStart && (seqEnd == null || row.seq <= seqEnd))
  if (query?.trim()) {
    const matches = recallMatcher(query.trim())
    rows = rows.filter((row) => {
      const rendered = recallEventText(row.event)
      return !!rendered && matches(`${rendered.speaker}\n${rendered.text}`)
    })
  }
  return rows
}

export const recallInputShape = {
  query: z.string().optional().describe("Case-insensitive text or regex-lite search query."),
  seq_start: z.number().int().nonnegative().optional().describe("First event sequence number to read (inclusive)."),
  seq_end: z.number().int().nonnegative().optional().describe("Last event sequence number to read (inclusive)."),
  session_id: z.string().optional().describe("Session id; defaults to the current session."),
  limit: z.number().int().positive().optional().describe(`Maximum events returned (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`),
  tool: z.string().optional().describe("Match tool.start/tool.end by tool name."),
  speaker: z.enum(["user", "assistant", "reasoning", "tool"]).optional(),
  turn_start: z.number().int().positive().optional(),
  turn_end: z.number().int().positive().optional(),
  before_compaction: z.boolean().optional().describe("Only events before the latest persisted context.compacted marker."),
  window: z.number().int().optional().describe("Restrict to one context window: 1-based from the first, negative from the end (-1 = current, -2 = previous)."),
  list_windows: z.boolean().optional().describe("List every context window with its seq range, turns, event counts, and first user message; ignores other filters."),
}

export const recall = tool(
  async (
    { query, seq_start, seq_end, session_id, limit, tool, speaker, turn_start, turn_end, before_compaction, window, list_windows }: {
      query?: string; seq_start?: number; seq_end?: number; session_id?: string; limit?: number; tool?: string; speaker?: string; turn_start?: number; turn_end?: number; before_compaction?: boolean; window?: number; list_windows?: boolean
    },
    config?: unknown,
  ) => {
    if (!list_windows && !query?.trim() && seq_start == null && window == null) return "error: provide query, seq_start, window, or list_windows."
    if (window != null && (!Number.isInteger(window) || window === 0)) return "error: window must be a non-zero integer (positive from the first window, negative from the current one)."
    if (seq_start != null && (!Number.isInteger(seq_start) || seq_start < 0)) return "error: seq_start must be a non-negative integer."
    if (seq_end != null && (!Number.isInteger(seq_end) || seq_end < 0)) return "error: seq_end must be a non-negative integer."
    if (seq_start != null && seq_end != null && seq_end < seq_start) return "error: seq_end must be greater than or equal to seq_start."

    const threadId = (config as any)?.configurable?.thread_id as string | undefined
    const currentSession = sessionForThread(threadId) ?? threadId
    const targetSession = session_id?.trim() || currentSession
    if (!targetSession) return "error: recall is only available inside an active session run."
    if (!Store.exists(targetSession)) return `error: unknown session "${targetSession}" — call list_sessions to find a valid id.`

    const pageSize = Math.max(1, Math.min(Math.floor(limit ?? DEFAULT_LIMIT), MAX_LIMIT))
    const history = Store.historyWithSeq(targetSession)
    const compactSeq = history.findLast((row) => row.event.type === "context.compacted")?.seq
    const turns = Store.turns(targetSession)
    const windows = recallWindows(history)
    if (list_windows) return `Context windows for session ${targetSession} (${windows.length}):\n${describeRecallWindows(history, turns, windows)}`
    const turnStartSeq = turn_start != null ? turns.find((t: any) => t.turnIndex === turn_start)?.startEventSeq : undefined
    const turnEndSeq = turn_end != null ? turns.find((t: any) => t.turnIndex === turn_end)?.endEventSeq : undefined
    let seqStart = turnStartSeq ?? seq_start
    let seqEnd = turnEndSeq ?? seq_end
    if (window != null) {
      const selected = resolveRecallWindow(windows, window)
      if (!selected) return `error: window ${window} does not exist; this session has ${windows.length} window(s) — use list_windows.`
      seqStart = Math.max(seqStart ?? selected.seqStart, selected.seqStart)
      seqEnd = Math.min(seqEnd ?? selected.seqEnd, selected.seqEnd)
    }
    let rows = filterRecallEvents(history, { query, seqStart, seqEnd, tool, speaker, beforeSeq: before_compaction ? compactSeq : undefined })
    const total = rows.length
    rows = rows.slice(0, pageSize)
    const mode = query?.trim() ? "Search results" : "Transcript"
    const scope = window != null ? ` (window ${window > 0 ? window : windows.length + 1 + window} of ${windows.length}, seq ${seqStart}–${seqEnd})` : ""
    const suffix = total > rows.length ? `\n\n[${total - rows.length} more matching events; use seq_start/seq_end to page by the seq numbers above.]` : ""
    return `${mode} for session ${targetSession}${scope}:\n${renderRecallEvents(rows, !!query?.trim())}${suffix}`
  },
  {
    name: "recall",
    description:
      "Search or page the durable session transcript, especially to retrieve context from before compaction. " +
      "Use query for case-insensitive substring/regex-lite search; every result line starts with its seq number, then use seq_start and seq_end to read a range (cite those seqs in notes). " +
      "Context windows are the spans between compactions: list_windows summarizes each (seq range, turns, first user message, current marked); window=N or window=-2 (previous window; -1 = current) restricts the seq range. " +
      "Optionally filter by tool, speaker, turn_start/turn_end, or before_compaction; filters compose with query and seq ranges. Output is capped; narrow queries/ranges for more detail.",
    schema: z.object(recallInputShape).refine((value) => !!value.query?.trim() || value.seq_start != null || value.window != null || !!value.list_windows, { message: "Provide query, seq_start, window, or list_windows." }),
  },
)
