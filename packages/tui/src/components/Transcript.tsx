import { createContext, Fragment, useCallback, useContext, useEffect, useState } from "react"
import { TextAttributes } from "@opentui/core"
import type { Item, ThreadNode, TranscriptState } from "../transcript.js"
import { MAIN } from "../transcript.js"
import { rawModeSupported, useInput } from "../useInput.js"
import { writeClipboard } from "../clipboard.js"
import { useToast } from "./Toast.js"
import { getSyntaxStyle } from "../syntaxStyle.js"
import type { DisplayItem } from "../collapseToolRuns.js"
import { buildRenderPlan } from "../renderPlan.js"
import {
  ACCENT,
  ACCENT_DEEP,
  BORDER,
  DOT,
  ERROR,
  MARKER,
  SPARKLE,
  SPINNER_FRAMES,
  SUCCESS,
  WARNING,
} from "../theme.js"

const { BOLD, DIM } = TextAttributes

/** Per-item collapse/expand state (reasoning blocks + tool output), shared with
 *  the deeply-nested ItemView without prop-drilling. Keyed by a stable per-item
 *  id ("r:<id>" for reasoning, "t:<toolId>" for tools). Mouse-click toggles it. */
const ItemExpandContext = createContext<{ expanded: Set<string>; toggle: (key: string) => void }>({
  expanded: new Set(),
  toggle: () => {},
})

/** Max output lines shown when a tool result is expanded (guards against a
 *  100k-line bash dump flooding the transcript). */
const TOOL_OUTPUT_MAX_LINES = 200

/** How many lines of live tool progress to keep on screen while a tool runs.
 *  A tail, not a log: enough to see the thing is moving and where it is, few
 *  enough that a chatty build doesn't push the conversation off the terminal.
 *  On tool.end the whole tail is replaced by the normal one-line summary. */
const TOOL_PROGRESS_TAIL_LINES = 6

/** Last N non-empty-ish lines of streamed progress, for the live tail view. */
function progressTail(progress: string): string[] {
  const lines = progress.split("\n")
  // A trailing newline yields a final "" that would render as a blank row and
  // make the tail look like it's stalling — drop it, but keep interior blanks.
  if (lines[lines.length - 1] === "") lines.pop()
  return lines.slice(-TOOL_PROGRESS_TAIL_LINES)
}

// Max chars for a coalesced group's trailing input hint, mirroring kimi's
// TOOL_SUMMARY_MAX_LENGTH — tighter than a lone tool's header so the "×N" count
// and the summary both fit on one line.
const TOOL_SUMMARY_MAX_LENGTH = 50
/** Live-activity preview budgets (the preview must never wrap). */
const ACTIVITY_INPUT_MAX = 28
const ACTIVITY_TAIL_MAX = 70
const PREVIEW_MAX = 96
/** Hide the idle clock under this; tint it WARNING past the second threshold. */
const IDLE_SHOW_MS = 10_000
const IDLE_WARN_MS = 60_000

/** One shared 1s ticker for every thread's clocks — subscribers share a single
 *  interval, so N running children don't create N timers. */
let clockSubs = new Set<() => void>()
let clockTimer: ReturnType<typeof setInterval> | null = null
function useClockTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const sub = () => setNow(Date.now())
    clockSubs.add(sub)
    clockTimer ??= setInterval(() => {
      for (const s of clockSubs) s()
    }, 1000)
    return () => {
      clockSubs.delete(sub)
      if (clockSubs.size === 0 && clockTimer) {
        clearInterval(clockTimer)
        clockTimer = null
      }
    }
  }, [active])
  return now
}

/** Compact token count for notices: 1234 → "1.2k", 1_500_000 → "1.5M". */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 10_000) return `${Math.round(n / 1000)}k`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

/** One-line cold-cache notice, e.g. "Cache cold after 42m idle — ~98k tokens
 *  will re-send. Consider a fresh thread." */
function cacheWarningText(item: Extract<Item, { kind: "cache-warning" }>): string {
  const tokens = `~${fmtTokens(item.approxTokens)} tokens re-sent`
  if (item.reason === "model-switch") {
    const models = item.fromModel && item.toModel ? ` (${item.fromModel} → ${item.toModel})` : ""
    return `Cache cold after model switch${models} — ${tokens}. Consider a fresh thread.`
  }
  const mins = item.idleMs != null ? Math.round(item.idleMs / 60_000) : 0
  return `Cache cold after ${mins}m idle — ${tokens}. Consider a fresh thread.`
}

/**
 * The transcript is a TREE of threads. The main session thread renders inline
 * (no frame); every spawned child thread renders as an indented block under its
 * parent — a coloured left rail, a header with its title + live status, and its
 * own streamed items. Child threads can nest (a child of a child indents again),
 * so concurrent delegated work is legible at a glance. Net-new vs Claude Code.
 */
export function Transcript({
  state,
  collapsed = false,
}: {
  state: TranscriptState
  collapsed?: boolean
}) {
  const main = state.threads[MAIN]

  // Per-thread expand state so a fan-out of spawned threads can't flood the
  // screen: every child thread renders as a ONE-LINE preview by default, and the
  // user expands the ones they want to read. `Ctrl+↑/↓` moves the focus caret;
  // `Ctrl+O` toggles the focused thread (the newest one when nothing is focused).
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const toast = useToast()
  // Per-item expand state for reasoning blocks + tool output (click to toggle).
  const [expandedItems, setExpandedItems] = useState<Set<string>>(() => new Set())
  const toggleItem = useCallback((key: string) => {
    setExpandedItems((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const threadIds = state.order.filter((id) => id !== MAIN)

  useInput(
    (input, key) => {
      if (key.ctrl && (input === "y" || input === "Y")) {
        const target = focusedId ? state.threads[focusedId] : main
        const text = [...(target?.items ?? [])]
          .reverse()
          .find((item) => item.kind === "assistant" && item.text.trim())
        if (text?.kind === "assistant") {
          void writeClipboard(text.text)
          toast.show({ message: "Copied latest assistant message", variant: "success" })
        }
        return
      }
      if (threadIds.length === 0) return
      // Default focus = the NEWEST thread, so a bare Ctrl+O expands the latest.
      const curIdx = focusedId && threadIds.includes(focusedId) ? threadIds.indexOf(focusedId) : threadIds.length - 1
      if (key.ctrl && key.downArrow) {
        setFocusedId(threadIds[(curIdx + 1) % threadIds.length] ?? null)
        return
      }
      if (key.ctrl && key.upArrow) {
        setFocusedId(threadIds[(curIdx - 1 + threadIds.length) % threadIds.length] ?? null)
        return
      }
      if (key.ctrl && (input === "o" || input === "O")) {
        const target = focusedId && threadIds.includes(focusedId) ? focusedId : threadIds[threadIds.length - 1]
        if (!target) return
        setFocusedId(target)
        setExpanded((prev) => {
          const next = new Set(prev)
          if (next.has(target)) next.delete(target)
          else next.add(target)
          return next
        })
      }
    },
    { isActive: rawModeSupported },
  )

  if (!main) return null
  // The caret target (highlighted, toggled by a bare Ctrl+O) defaults to newest.
  const effectiveFocus = focusedId && threadIds.includes(focusedId) ? focusedId : (threadIds[threadIds.length - 1] ?? null)
  return (
    <ItemExpandContext.Provider value={{ expanded: expandedItems, toggle: toggleItem }}>
      <box flexDirection="column">
        <ParentBody
          items={main.items}
          parentId={MAIN}
          state={state}
          depth={0}
          collapsed={collapsed}
          expanded={expanded}
          focusedId={effectiveFocus}
        />
      </box>
    </ItemExpandContext.Provider>
  )
}

/**
 * Render a parent thread's OWN items with its child-thread blocks interleaved at
 * each child's spawn anchor, so the stream reads in true chronological order — a
 * parent's post-spawn output (e.g. its final summary) sits BELOW the threads that
 * produced it, not above them. Recurses through ThreadBlock for nested threads.
 */
function ParentBody({
  items,
  parentId,
  state,
  depth,
  collapsed,
  expanded,
  focusedId,
}: {
  items: Item[]
  parentId: string
  state: TranscriptState
  depth: number
  collapsed: boolean
  expanded: Set<string>
  focusedId: string | null
}) {
  const children = state.order
    .map((id) => state.threads[id]!)
    .filter((t) => t.parentId === parentId)
  const plan = buildRenderPlan(items, children)
  return (
    <>
      {plan.map((node, i) => (
        <Fragment key={i}>
          {node.kind === "items"
            ? node.items.map((it, j) => <ItemView key={j} item={it} />)
            : node.threads.map((thread) => (
                <ThreadBlock
                  key={thread.id}
                  thread={thread}
                  state={state}
                  depth={depth}
                  collapsed={collapsed}
                  expanded={expanded}
                  focusedId={focusedId}
                />
              ))}
        </Fragment>
      ))}
    </>
  )
}

/** The most representative one line of a collapsed thread: the first line of its
 *  latest assistant reply, else the newest tool/log/error line. */
function threadPreview(items: Item[]): { text: string; more: number } {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!
    if (it.kind === "assistant" && it.text.trim()) {
      const lines = it.text.split("\n").map((l) => l.trim()).filter(Boolean)
      return { text: lines[0] ?? "", more: Math.max(0, lines.length - 1) }
    }
  }
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!
    if (it.kind === "tool") return { text: `${it.name}…`, more: 0 }
    if (it.kind === "workflow-log") return { text: it.message, more: 0 }
    if (it.kind === "error") return { text: `error: ${it.text}`, more: 0 }
  }
  return { text: "", more: 0 }
}

/** The newest sign of life in a RUNNING thread, as one short line: a running
 *  tool renders as `name(input summary)`, streaming text renders as its tail. */
function liveActivity(items: Item[]): string {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!
    if (it.kind === "tool" && !it.done) {
      const hint = summarizeInput(it.input, ACTIVITY_INPUT_MAX)
      return hint ? `${it.name}(${hint})` : it.name
    }
    if ((it.kind === "assistant" || it.kind === "reasoning") && it.streaming) {
      const tail = tailText(it.text)
      if (tail) return tail
    }
    if (it.kind === "tool" || it.kind === "assistant" || it.kind === "reasoning") break
  }
  return ""
}

/** Last ~70 chars of streaming text, collapsed to a single whitespace-free line. */
function tailText(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim()
  if (!flat) return ""
  return flat.length > ACTIVITY_TAIL_MAX ? `…${flat.slice(flat.length - ACTIVITY_TAIL_MAX)}` : flat
}

/** Compact duration: 45s / 1m12s / 1h02m. */
function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  if (total < 60) return `${total}s`
  const mins = Math.floor(total / 60)
  if (mins < 60) return `${mins}m${String(total % 60).padStart(2, "0")}s`
  return `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, "0")}m`
}

/**
 * One child thread. `Ctrl+T` (global) folds every thread to a header line; by
 * default each thread shows a ONE-LINE preview and expands per-thread (`Ctrl+O`
 * on the focused thread). The header carries the model running the thread and a
 * ▸/▾ caret; the focused thread is accented with an inline toggle hint.
 */
function ThreadBlock({
  thread,
  state,
  depth,
  collapsed,
  expanded,
  focusedId,
}: {
  thread: ThreadNode
  state: TranscriptState
  depth: number
  collapsed: boolean
  expanded: Set<string>
  focusedId: string | null
}) {
  const running = thread.status === "running"
  const rail = depth % 2 === 0 ? ACCENT : ACCENT_DEEP
  const childCount = state.order.filter((id) => state.threads[id]!.parentId === thread.id).length
  const isFocused = focusedId === thread.id
  const isExpanded = expanded.has(thread.id)
  // collapsed (global Ctrl+T) → header + count only; else per-thread: full body
  // when expanded, otherwise a one-line preview.
  const showBody = !collapsed && isExpanded
  const showPreview = !collapsed && !isExpanded
  const headFg = isFocused ? ACCENT : rail
  // Re-render the clocks/activity on a shared 1s tick while this thread runs.
  const now = useClockTick(running)
  const preview = showPreview ? threadPreview(thread.items) : null
  const activity = running ? liveActivity(thread.items) : ""
  const elapsed = running && thread.startedAt != null ? formatDuration(now - thread.startedAt) : null
  const idleMs = running && thread.lastEventAt != null ? now - thread.lastEventAt : 0
  const showIdle = idleMs >= IDLE_SHOW_MS
  const idleStuck = idleMs >= IDLE_WARN_MS
  const countLabel = `${thread.items.length} item${thread.items.length === 1 ? "" : "s"}${
    childCount > 0 ? `, ${childCount} sub` : ""
  }`

  return (
    <box flexDirection="column" marginTop={1} marginLeft={depth === 0 ? 0 : 2}>
      {/* header */}
      <box flexDirection="row">
        <text fg={rail}>{"├─ "}</text>
        {running ? <Spinner color={rail} /> : <text fg={ACCENT}>{DOT}</text>}
        <text fg={headFg}>{` ${showBody ? "▾" : "▸"} `}</text>
        <text fg={headFg} attributes={BOLD}>
          thread: {thread.title}
        </text>
        {thread.model ? <text attributes={DIM}>{`  · ${thread.model}`}</text> : null}
        {running ? (
          <>
            <text attributes={DIM}>{elapsed ? `  (running… ${elapsed}` : "  (running…"}</text>
            {showIdle ? (
              <text fg={idleStuck ? WARNING : undefined} attributes={DIM}>
                {` · idle ${formatDuration(idleMs)}`}
              </text>
            ) : null}
            <text attributes={DIM}>{")"}</text>
          </>
        ) : (
          <text attributes={DIM}>{"  (done)"}</text>
        )}
        {collapsed && (thread.items.length > 0 || childCount > 0) && (
          <text attributes={DIM}>{`  ${countLabel}`}</text>
        )}
        {isFocused && !collapsed && (
          <text fg={ACCENT} attributes={DIM}>{isExpanded ? "  ⌃O collapse" : "  ⌃O expand"}</text>
        )}
      </box>

      {/* one-line preview (collapsed-by-default state) */}
      {showPreview && (
        <box flexDirection="row">
          <box flexDirection="column" marginRight={1}>
            <text fg={rail}>{"│"}</text>
          </box>
          <box flexDirection="column" flexGrow={1}>
            {running ? (
              // Live: newest activity + item count, always ONE truncated line.
              <text attributes={DIM}>
                {truncate(activity ? `${countLabel} · ${activity}` : countLabel, PREVIEW_MAX) + " …"}
              </text>
            ) : preview && preview.text ? (
              <text attributes={DIM}>
                {truncate(preview.text, 80)}
                {preview.more > 0 ? `  (+${preview.more} more lines · ⌃O)` : ""}
              </text>
            ) : (
              <text attributes={DIM}>
                {countLabel}
                {running ? " …" : ""}
              </text>
            )}
          </box>
        </box>
      )}

      {/* full body when expanded: left rail + items with nested threads inlined */}
      {showBody && (
        <box flexDirection="row">
          <box flexDirection="column" marginRight={1}>
            <text fg={rail}>{"│"}</text>
          </box>
          <box flexDirection="column" flexGrow={1}>
            <ParentBody
              items={thread.items}
              parentId={thread.id}
              state={state}
              depth={depth + 1}
              collapsed={collapsed}
              expanded={expanded}
              focusedId={focusedId}
            />
          </box>
        </box>
      )}
    </box>
  )
}

/** A compact one-cell spinner reused from the status line frames. */
function Spinner({ color }: { color: string }) {
  const [frame, setFrame] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 90)
    return () => clearInterval(t)
  }, [])
  return <text fg={color}>{SPINNER_FRAMES[frame]}</text>
}

export function ItemView({ item }: { item: DisplayItem }) {
  const expandCtx = useContext(ItemExpandContext)
  switch (item.kind) {
    case "reasoning": {
      // Collapsible thought block. While streaming, the body shows live (watch it
      // think) with a spinner; once done it collapses to a one-line header you can
      // click to re-expand. Dimmed throughout — it's subordinate to the answer.
      const key = `r:${item.id}`
      const open = expandCtx.expanded.has(key)
      const showBody = item.streaming || open
      return (
        <box marginTop={1} flexDirection="column">
          <box
            flexDirection="row"
            onMouseDown={
              item.streaming
                ? undefined
                : (e) => {
                    e.stopPropagation()
                    expandCtx.toggle(key)
                  }
            }
          >
            {item.streaming ? <Spinner color={MARKER} /> : <text fg={MARKER}>{SPARKLE}</text>}
            <text fg={MARKER} attributes={DIM}>
              {item.streaming ? " Thinking…" : ` Thought${open ? "  ▾" : "  ▸"}`}
            </text>
          </box>
          {showBody && item.text ? (
            <box marginLeft={2} flexDirection="column">
              <text attributes={DIM}>{item.text}</text>
            </box>
          ) : null}
        </box>
      )
    }

    case "tool-group": {
      // A coalesced run: one line, a status dot (grey spinner while any call is
      // in flight → purple ⏺ once all done), a by-category summary ("read 5 files ·
      // ran 4 commands"), and only the LAST call's input as a hint. No ⎿ preview —
      // that's the whole point.
      const hint = summarizeInput(item.lastInput, TOOL_SUMMARY_MAX_LENGTH)
      return (
        <box flexDirection="row" marginTop={1}>
          {item.running ? <Spinner color={BORDER} /> : <text fg={ACCENT}>{DOT}</text>}
          <text attributes={BOLD}> {item.summary}</text>
          {hint ? <text attributes={DIM}> · {hint}</text> : null}
        </box>
      )
    }

    case "user":
      return (
        <box marginTop={1} flexDirection="column">
          {item.from && (
            // A message injected by another session (send_to_session) — show
            // provenance so it doesn't read as something the user typed.
            <text fg={MARKER}>{`⇄ from session ${item.from}`}</text>
          )}
          <box flexDirection="row">
            <text fg={ACCENT}>{"> "}</text>
            <text>{item.text}</text>
          </box>
        </box>
      )

    case "assistant":
      return (
        <box marginTop={1} flexDirection="column" width="100%">
          <box flexDirection="row" width="100%">
            <text fg={ACCENT}>{DOT} </text>
            {/* flexGrow so long lines wrap inside the remaining columns instead of
                overflowing and reflowing under the sparkle marker. */}
            <box flexDirection="column" flexGrow={1} flexShrink={1}>
              {/* OpenTUI's markdown renderable: tree-sitter syntax-highlighted
                  fenced code (md/ts/js/zig bundled; other langs render plain),
                  tables, links, headings — all styled via the shared SyntaxStyle.
                  `conceal` hides the raw markers (**, #, `) for clean prose;
                  `streaming` keeps the trailing block live until the turn ends. */}
              <markdown
                content={item.text}
                syntaxStyle={getSyntaxStyle()}
                streaming={item.streaming}
                conceal
              />
            </box>
          </box>
          {item.endReason === "max_tokens" ? <text fg={WARNING}>⚠ Response stopped at the output limit.</text> : null}
          {item.endReason === "interrupted" ? <text attributes={DIM}>⏹ Response interrupted.</text> : null}
          {item.endReason === "error" ? <text fg={ERROR}>✗ Response ended unexpectedly.</text> : null}
        </box>
      )

    case "tool": {
      // rate_delegate is bookkeeping, not work: render it as one dim annotation
      // line (no dot, no bold header, no expandable output) so it reads as a
      // footnote to the delegation above it rather than a peer tool call.
      if (item.name === "rate_delegate") {
        const input = (item.input ?? {}) as { rating?: number; rework?: boolean; reason?: string }
        const rating = typeof input.rating === "number" ? `${input.rating}/10` : "…"
        const reason = typeof input.reason === "string" ? input.reason : ""
        return (
          <box flexDirection="row" marginLeft={2}>
            <text attributes={DIM}>
              {"⭑ rated "}
              {rating}
              {input.rework ? " (rework)" : ""}
              {reason ? ` · ${truncate(reason, TOOL_SUMMARY_MAX_LENGTH)}` : ""}
            </text>
          </box>
        )
      }
      const output = item.output ?? ""
      const lines = output.split("\n")
      // Expandable when there's more than the one-line summary shows.
      const expandable = item.done && (lines.length > 1 || output.length > 80)
      const key = `t:${item.id}`
      const open = expandable && expandCtx.expanded.has(key)
      const shown = open ? lines.slice(0, TOOL_OUTPUT_MAX_LINES) : []
      // Live tail: only while the call is in flight. Once done, this is empty and
      // the row renders exactly as it always has (summary + expandable output).
      const tail = !item.done && item.progress ? progressTail(item.progress) : []
      return (
        <box marginTop={1} flexDirection="column">
          <box flexDirection="row">
            <text fg={ACCENT}>{DOT} </text>
            <text attributes={BOLD}>{item.name}</text>
            <text attributes={DIM}>({summarizeInput(item.input)})</text>
          </box>
          {tail.length > 0 && (
            <box flexDirection="column" marginLeft={4}>
              {tail.map((l, k) => (
                <text key={k} attributes={DIM}>
                  {l.length === 0 ? " " : l}
                </text>
              ))}
            </box>
          )}
          {item.done && (
            <box
              flexDirection="row"
              marginLeft={2}
              onMouseDown={
                expandable
                  ? (e) => {
                      e.stopPropagation()
                      expandCtx.toggle(key)
                    }
                  : undefined
              }
            >
              <text attributes={DIM}>
                {"  ⎿  "}
                <span fg={item.ok ? SUCCESS : ERROR}>{item.ok ? "" : "error: "}</span>
                {open ? `${lines.length} lines` : summarizeOutput(output)}
                {expandable ? (open ? "  ▾" : "  ▸") : ""}
              </text>
            </box>
          )}
          {open && (
            <box flexDirection="column" marginLeft={4}>
              {shown.map((l, k) => (
                <text key={k} attributes={DIM}>
                  {l.length === 0 ? " " : l}
                </text>
              ))}
              {lines.length > TOOL_OUTPUT_MAX_LINES ? (
                <text attributes={DIM}>{`  … +${lines.length - TOOL_OUTPUT_MAX_LINES} more lines`}</text>
              ) : null}
            </box>
          )}
        </box>
      )
    }

    case "error":
      return (
        <box flexDirection="row" marginTop={1}>
          <text fg={ERROR}>✗ {item.text}</text>
        </box>
      )

    case "cache-warning":
      return (
        <box flexDirection="row" marginTop={1}>
          <text fg={WARNING}>⚠ {cacheWarningText(item)}</text>
        </box>
      )

    case "goal": {
      // Goal-mode marker. Color by outcome; the message already carries a glyph.
      const color =
        item.status === "complete"
          ? SUCCESS
          : item.status === "blocked"
            ? ERROR
            : item.status === "paused" || item.status === "cleared"
              ? BORDER
              : ACCENT
      return (
        <box flexDirection="row" marginTop={1}>
          <text fg={color} attributes={BOLD}>
            {item.message}
          </text>
        </box>
      )
    }

    case "workflow-phase":
      return (
        <box flexDirection="row" marginTop={1}>
          <text fg={ACCENT} attributes={BOLD}>
            ◆ {item.title}
          </text>
        </box>
      )

    case "workflow-log":
      return (
        <box flexDirection="row">
          <text fg={MARKER}>{item.message}</text>
        </box>
      )
  }
}

function summarizeInput(input: unknown, max = 60): string {
  if (input == null) return ""
  if (typeof input === "string") return truncate(input, max)
  try {
    const entries = Object.entries(input as Record<string, unknown>)
    return truncate(entries.map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(", "), max)
  } catch {
    return ""
  }
}

function summarizeOutput(output: string): string {
  const firstLine = output.split("\n")[0] ?? ""
  const extra = output.includes("\n") ? ` (+${output.split("\n").length - 1} lines)` : ""
  return truncate(firstLine, 70) + extra
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s
}
