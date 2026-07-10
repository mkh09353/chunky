import React, { useEffect, useState } from "react"
import { Box, Text } from "ink"
import type { Item, ThreadNode, TranscriptState } from "../transcript.js"
import { MAIN } from "../transcript.js"
import { collapseToolRuns, type DisplayItem } from "../collapseToolRuns.js"
import { parseBlocks, parseInline, type MdSpan } from "../markdown.js"
import {
  ACCENT,
  ACCENT_DEEP,
  BORDER,
  CODE,
  CODE_MUTED,
  DOT,
  ERROR,
  SPINNER_FRAMES,
  SUCCESS,
  WARNING,
} from "../theme.js"

// Max chars for a coalesced group's trailing input hint, mirroring kimi's
// TOOL_SUMMARY_MAX_LENGTH — tighter than a lone tool's header so the "×N" count
// and the summary both fit on one line.
const TOOL_SUMMARY_MAX_LENGTH = 50

/** Compact token count for notices: 1234 → "1.2k", 1_500_000 → "1.5M". */
function fmtTokens(n: number): string {
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
  if (!main) return null
  return (
    <Box flexDirection="column">
      {collapseToolRuns(main.items).map((it, i) => (
        <ItemView key={i} item={it} />
      ))}
      <ThreadChildren parentId={MAIN} state={state} depth={0} collapsed={collapsed} />
    </Box>
  )
}

/** Render every thread whose parent is `parentId`, recursively. */
function ThreadChildren({
  parentId,
  state,
  depth,
  collapsed,
}: {
  parentId: string
  state: TranscriptState
  depth: number
  collapsed: boolean
}) {
  const children = state.order
    .map((id) => state.threads[id]!)
    .filter((t) => t.parentId === parentId)
  if (children.length === 0) return null
  return (
    <>
      {children.map((thread) => (
        <ThreadBlock key={thread.id} thread={thread} state={state} depth={depth} collapsed={collapsed} />
      ))}
    </>
  )
}

/** One child thread: header (title + status) and, unless collapsed, its body. */
function ThreadBlock({
  thread,
  state,
  depth,
  collapsed,
}: {
  thread: ThreadNode
  state: TranscriptState
  depth: number
  collapsed: boolean
}) {
  const running = thread.status === "running"
  const rail = depth % 2 === 0 ? ACCENT : ACCENT_DEEP
  const childCount = state.order.filter((id) => state.threads[id]!.parentId === thread.id).length
  return (
    <Box flexDirection="column" marginTop={1} marginLeft={depth === 0 ? 0 : 2}>
      {/* header */}
      <Box>
        <Text color={rail}>{"├─ "}</Text>
        {running ? <Spinner color={rail} /> : <Text color={SUCCESS}>{DOT}</Text>}
        <Text bold color={rail}>
          {" "}
          thread: {thread.title}
        </Text>
        <Text dimColor>{running ? "  (running…)" : "  (done)"}</Text>
        {collapsed && (thread.items.length > 0 || childCount > 0) && (
          <Text dimColor>
            {"  "}
            {thread.items.length} item{thread.items.length === 1 ? "" : "s"}
            {childCount > 0 ? `, ${childCount} sub` : ""}
          </Text>
        )}
      </Box>

      {/* body: left rail + items, then nested children */}
      {!collapsed && (
        <Box flexDirection="row">
          <Box flexDirection="column" marginRight={1}>
            <Text color={rail}>{"│"}</Text>
          </Box>
          <Box flexDirection="column" flexGrow={1}>
            {collapseToolRuns(thread.items).map((it, i) => (
              <ItemView key={i} item={it} />
            ))}
            <ThreadChildren parentId={thread.id} state={state} depth={depth + 1} collapsed={collapsed} />
          </Box>
        </Box>
      )}
    </Box>
  )
}

/** A compact one-cell spinner reused from the status line frames. */
function Spinner({ color }: { color: string }) {
  const [frame, setFrame] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 90)
    return () => clearInterval(t)
  }, [])
  return <Text color={color}>{SPINNER_FRAMES[frame]}</Text>
}

export function ItemView({ item }: { item: DisplayItem }) {
  switch (item.kind) {
    case "tool-group": {
      // A coalesced run: one line, a status dot (grey spinner while any call is
      // in flight → green ⏺ once all done), the tool name, an ×N count, and only
      // the LAST call's input as a hint. No ⎿ preview — that's the whole point.
      const hint = summarizeInput(item.lastInput, TOOL_SUMMARY_MAX_LENGTH)
      return (
        <Box marginTop={1}>
          {item.running ? <Spinner color={BORDER} /> : <Text color={SUCCESS}>{DOT}</Text>}
          <Text bold> {item.name}</Text>
          <Text dimColor> ×{item.count}</Text>
          {hint ? <Text dimColor> · {hint}</Text> : null}
        </Box>
      )
    }

    case "user":
      return (
        <Box marginTop={1}>
          <Text color={ACCENT}>{"> "}</Text>
          <Text>{item.text}</Text>
        </Box>
      )

    case "assistant":
      return (
        <Box marginTop={1} flexDirection="row" width="100%">
          <Text color={ACCENT}>{DOT} </Text>
          {/* flexGrow so long lines wrap inside the remaining columns instead of
              overflowing and reflowing under the sparkle marker. */}
          <Box flexDirection="column" flexGrow={1} flexShrink={1}>
            <Markdown text={item.text} />
          </Box>
        </Box>
      )

    case "tool":
      return (
        <Box marginTop={1} flexDirection="column">
          <Box>
            <Text color={ACCENT}>{DOT} </Text>
            <Text bold>{item.name}</Text>
            <Text dimColor>({summarizeInput(item.input)})</Text>
          </Box>
          {item.done && (
            <Box marginLeft={2}>
              <Text dimColor>
                {"  ⎿  "}
                <Text color={item.ok ? SUCCESS : ERROR}>{item.ok ? "" : "error: "}</Text>
                {summarizeOutput(item.output ?? "")}
              </Text>
            </Box>
          )}
        </Box>
      )

    case "error":
      return (
        <Box marginTop={1}>
          <Text color={ERROR}>✗ {item.text}</Text>
        </Box>
      )

    case "cache-warning":
      return (
        <Box marginTop={1}>
          <Text color={WARNING}>⚠ {cacheWarningText(item)}</Text>
        </Box>
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
    <Box flexDirection="column">
      {blocks.map((b, i) => {
        switch (b.kind) {
          case "blank":
            // A single empty row between sections (Ink collapses pure empties).
            return <Text key={i}>{" "}</Text>

          case "hr":
            return (
              <Text key={i} dimColor>
                {"─".repeat(24)}
              </Text>
            )

          case "heading":
            return (
              <Text key={i} bold color={ACCENT}>
                <Inline text={b.text} />
              </Text>
            )

          case "bullet":
            return (
              <Text key={i}>
                {" ".repeat(b.indent)}
                <Text color={ACCENT}>• </Text>
                <Inline text={b.text} />
              </Text>
            )

          case "numbered":
            return (
              <Text key={i}>
                {" ".repeat(b.indent)}
                <Text color={ACCENT}>{b.n}. </Text>
                <Inline text={b.text} />
              </Text>
            )

          case "code":
            return (
              <Box key={i} flexDirection="column" marginY={0}>
                {b.lang ? (
                  <Text dimColor color={CODE_MUTED}>
                    {"  "}
                    {b.lang}
                  </Text>
                ) : null}
                {(b.lines.length === 0 ? [""] : b.lines).map((line, j) => (
                  <Text key={j} color={CODE}>
                    {"  "}
                    {line.length === 0 ? " " : line}
                  </Text>
                ))}
              </Box>
            )

          case "paragraph":
            return (
              <Text key={i}>
                <Inline text={b.text} />
              </Text>
            )
        }
      })}
    </Box>
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
      return <Text bold>{span.text}</Text>
    case "italic":
      // Terminals rarely have true italic; dim+default is a quiet stand-in.
      return <Text dimColor italic>{span.text}</Text>
    case "code":
      // No surrounding backticks — colour alone marks it as code.
      return <Text color={CODE}>{span.text}</Text>
    case "text":
      return <Text>{span.text}</Text>
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
