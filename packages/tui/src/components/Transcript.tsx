import React, { useEffect, useState } from "react"
import { Box, Text } from "ink"
import type { Item, ThreadNode, TranscriptState } from "../transcript.js"
import { MAIN } from "../transcript.js"
import { ACCENT, ACCENT_DEEP, BORDER, DOT, ERROR, SPINNER_FRAMES, SUCCESS } from "../theme.js"

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
      {main.items.map((it, i) => (
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
            {thread.items.map((it, i) => (
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

export function ItemView({ item }: { item: Item }) {
  switch (item.kind) {
    case "user":
      return (
        <Box marginTop={1}>
          <Text color={ACCENT}>{"> "}</Text>
          <Text>{item.text}</Text>
        </Box>
      )

    case "assistant":
      return (
        <Box marginTop={1} flexDirection="row">
          <Text color={ACCENT}>{DOT} </Text>
          <Box flexDirection="column">
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
  }
}

/** Light markdown: bold headers, list bullets, and inline **bold** segments. */
function Markdown({ text }: { text: string }) {
  const lines = text.split("\n")
  return (
    <>
      {lines.map((line, i) => {
        const header = /^(#{1,6})\s+(.*)$/.exec(line)
        if (header) {
          return (
            <Text key={i} bold color={ACCENT}>
              {header[2]}
            </Text>
          )
        }
        const bullet = /^(\s*)([-*])\s+(.*)$/.exec(line)
        if (bullet) {
          return (
            <Text key={i}>
              {bullet[1]}
              <Text color={ACCENT}>• </Text>
              <Inline text={bullet[3]!} />
            </Text>
          )
        }
        const numbered = /^(\s*)(\d+)\.\s+(.*)$/.exec(line)
        if (numbered) {
          return (
            <Text key={i}>
              {numbered[1]}
              <Text color={ACCENT}>{numbered[2]}. </Text>
              <Inline text={numbered[3]!} />
            </Text>
          )
        }
        return (
          <Text key={i}>
            <Inline text={line} />
          </Text>
        )
      })}
    </>
  )
}

/** Render **bold** spans inline; everything else default fg. */
function Inline({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g)
  return (
    <>
      {parts.map((p, i) =>
        /^\*\*[^*]+\*\*$/.test(p) ? (
          <Text key={i} bold>
            {p.slice(2, -2)}
          </Text>
        ) : (
          <Text key={i}>{p}</Text>
        ),
      )}
    </>
  )
}

function summarizeInput(input: unknown): string {
  if (input == null) return ""
  if (typeof input === "string") return truncate(input, 60)
  try {
    const entries = Object.entries(input as Record<string, unknown>)
    return truncate(entries.map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(", "), 60)
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
