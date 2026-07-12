import { Fragment, useEffect, useState } from "react"
import { TextAttributes } from "@opentui/core"
import type { Item, ThreadNode, TranscriptState } from "../transcript.js"
import { MAIN } from "../transcript.js"
import { rawModeSupported, useInput } from "../useInput.js"
import type { DisplayItem } from "../collapseToolRuns.js"
import { buildRenderPlan } from "../renderPlan.js"
import { parseBlocks, parseInline, type MdSpan } from "../markdown.js"
import {
  ACCENT,
  ACCENT_DEEP,
  BORDER,
  CODE,
  CODE_MUTED,
  DOT,
  ERROR,
  HEADING,
  MARKER,
  MARKER_BULLET,
  SPINNER_FRAMES,
  SUCCESS,
  WARNING,
} from "../theme.js"

const { BOLD, DIM, ITALIC } = TextAttributes

// Max chars for a coalesced group's trailing input hint, mirroring kimi's
// TOOL_SUMMARY_MAX_LENGTH — tighter than a lone tool's header so the "×N" count
// and the summary both fit on one line.
const TOOL_SUMMARY_MAX_LENGTH = 50

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
  const [copyNotice, setCopyNotice] = useState<string | null>(null)

  const threadIds = state.order.filter((id) => id !== MAIN)

  useInput(
    (input, key) => {
      if (key.ctrl && (input === "y" || input === "Y")) {
        const target = focusedId ? state.threads[focusedId] : main
        const text = [...(target?.items ?? [])]
          .reverse()
          .find((item) => item.kind === "assistant" && item.text.trim())
        if (text?.kind === "assistant") {
          const proc = Bun.spawn(["pbcopy"], { stdin: "pipe" })
          proc.stdin.write(text.text)
          proc.stdin.end()
          setCopyNotice("Copied latest assistant message")
          setTimeout(() => setCopyNotice(null), 1500)
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
    <box flexDirection="column">
      {copyNotice ? <text fg={SUCCESS} attributes={DIM}>✓ {copyNotice}</text> : null}
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
  const preview = showPreview ? threadPreview(thread.items) : null
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
        <text attributes={DIM}>{running ? "  (running…)" : "  (done)"}</text>
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
            {preview && preview.text ? (
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
  switch (item.kind) {
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
              <Markdown text={item.text} />
            </box>
          </box>
          {item.endReason === "max_tokens" ? <text fg={WARNING}>⚠ Response stopped at the output limit.</text> : null}
          {item.endReason === "interrupted" ? <text attributes={DIM}>⏹ Response interrupted.</text> : null}
          {item.endReason === "error" ? <text fg={ERROR}>✗ Response ended unexpectedly.</text> : null}
        </box>
      )

    case "tool":
      return (
        <box marginTop={1} flexDirection="column">
          <box flexDirection="row">
            <text fg={ACCENT}>{DOT} </text>
            <text attributes={BOLD}>{item.name}</text>
            <text attributes={DIM}>({summarizeInput(item.input)})</text>
          </box>
          {item.done && (
            <box flexDirection="row" marginLeft={2}>
              <text attributes={DIM}>
                {"  ⎿  "}
                <span fg={item.ok ? SUCCESS : ERROR}>{item.ok ? "" : "error: "}</span>
                {summarizeOutput(item.output ?? "")}
              </text>
            </box>
          )}
        </box>
      )

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

/**
 * Terminal markdown: fenced code, inline code/bold/italic, headings, lists,
 * horizontal rules, and blank-line spacing. Keeps raw fences and backticks off
 * the screen so agent prose reads clean instead of like unrendered source.
 */
function Markdown({ text }: { text: string }) {
  const blocks = parseBlocks(text)
  return (
    <box flexDirection="column">
      {blocks.map((b, i) => {
        switch (b.kind) {
          case "blank":
            // A single empty row between sections.
            return <text key={i}>{" "}</text>

          case "hr":
            return (
              <text key={i} attributes={DIM}>
                {"─".repeat(24)}
              </text>
            )

          case "heading":
            return (
              <text key={i} fg={HEADING} attributes={BOLD}>
                <Inline text={b.text} />
              </text>
            )

          case "bullet":
            return (
              <text key={i}>
                {" ".repeat(b.indent)}
                <span fg={MARKER_BULLET}>• </span>
                <Inline text={b.text} />
              </text>
            )

          case "numbered":
            return (
              <text key={i}>
                {" ".repeat(b.indent)}
                <span fg={MARKER}>{b.n}. </span>
                <Inline text={b.text} />
              </text>
            )

          case "code":
            return (
              <box key={i} flexDirection="column">
                {b.lang ? (
                  <text fg={CODE_MUTED} attributes={DIM}>
                    {"  "}
                    {b.lang}
                  </text>
                ) : null}
                {(b.lines.length === 0 ? [""] : b.lines).map((line, j) => (
                  <text key={j} fg={CODE}>
                    {"  "}
                    {line.length === 0 ? " " : line}
                  </text>
                ))}
              </box>
            )

          case "paragraph":
            return (
              <text key={i}>
                <Inline text={b.text} />
              </text>
            )
        }
      })}
    </box>
  )
}

/** Render inline `code`, **bold**, and *italic* spans. */
function Inline({ text }: { text: string }) {
  const spans = parseInline(text)
  return (
    <>
      {spans.map((s, i) => (
        <SpanView key={i} span={s} />
      ))}
    </>
  )
}

function SpanView({ span }: { span: MdSpan }) {
  switch (span.kind) {
    case "bold":
      return <span attributes={BOLD}>{span.text}</span>
    case "italic":
      // Terminals rarely have true italic; dim+italic is a quiet stand-in.
      return <span attributes={DIM | ITALIC}>{span.text}</span>
    case "code":
      // No surrounding backticks — colour alone marks it as code.
      return <span fg={CODE}>{span.text}</span>
    case "text":
      return <span>{span.text}</span>
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
