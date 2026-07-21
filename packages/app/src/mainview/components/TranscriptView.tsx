import { Fragment, useCallback, useEffect, useRef, useState } from "react"
import type { MouseEvent as ReactMouseEvent } from "react"
import {
  ChatMessage,
  ChatMessageBubble,
  ChatMessageList,
  ChatSystemMessage,
  ChatToolCalls,
  type ChatToolCallItem,
} from "@astryxdesign/core/Chat"
import { Markdown } from "@astryxdesign/core/Markdown"
import { CodeBlock } from "@astryxdesign/core/CodeBlock"
import type { Item, ThreadNode, TranscriptState } from "../lib/transcript"
import { MAIN } from "../lib/transcript"
import { USER_ANCHOR_CLASS } from "../lib/minimap"
import { isHttpUrl, useOpenInBrowser } from "../lib/browser"
import {
  buildRenderPlan,
  childrenOf,
  threadPreview,
  type Group,
  type ToolItem,
} from "../lib/renderPlan"

/** Fenced code blocks longer than this collapse behind a "show more" affordance,
 *  so a 400-line file dump can't swallow the whole transcript. Picked to comfortably
 *  clear a typical function or config snippet (which should stay fully visible). */
const CODE_COLLAPSE_THRESHOLD = 30

/** Ceiling on a code block's rendered height. Blocks under the collapse threshold
 *  but with very long lines still scroll internally rather than pushing the
 *  conversation off screen. */
const CODE_MAX_HEIGHT = "32rem"

/**
 * Fenced code blocks in assistant markdown, rendered with the design system's
 * CodeBlock instead of Markdown's bare default: copy button, language label,
 * line numbers, and collapse-when-huge.
 *
 * Wired in via Markdown's `components.code` slot (see MARKDOWN_COMPONENTS), which
 * receives ONLY fenced blocks — inline `code` spans go through `components.inlineCode`,
 * which we deliberately leave unset so they keep the theme's default inline look.
 */
function TranscriptCodeBlock({ code, language }: { code: string; language?: string }) {
  // A trailing newline from the fence shouldn't count as a line — it would put a
  // phantom numbered row under the last statement of every block.
  const lineCount = code.replace(/\n$/, "").split("\n").length
  return (
    <CodeBlock
      code={code}
      language={language}
      hasCopyButton
      // Only label a block whose fence actually declared a language; an unlabelled
      // fence would otherwise render an empty chip.
      hasLanguageLabel={Boolean(language)}
      // Gutter numbers help nobody on a one-liner and cost horizontal room.
      hasLineNumbers={lineCount > 1}
      isCollapsible={lineCount > CODE_COLLAPSE_THRESHOLD}
      collapsibleThreshold={CODE_COLLAPSE_THRESHOLD}
      maxHeight={CODE_MAX_HEIGHT}
      // Fill the readable column rather than CodeBlock's default fit-content, so
      // consecutive blocks line up instead of stepping with their longest line.
      width="100%"
    />
  )
}

/** Module-level and frozen: Markdown re-parses when `components` changes identity,
 *  so an inline object literal here would re-render every block on every streamed
 *  delta and visibly break the isStreaming fade. */
const MARKDOWN_COMPONENTS = { code: TranscriptCodeBlock } as const

/** Collapse whitespace so multi-line inputs read as a single tidy summary line. */
function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim()
}

/** Best human-readable summary of a tool's arguments for the collapsed row. */
function toolTarget(input: unknown): string | undefined {
  if (typeof input === "string") return oneLine(input).slice(0, 96) || undefined
  if (!input || typeof input !== "object") return undefined
  const o = input as Record<string, unknown>
  // Prefer the field that best describes the action, in priority order.
  for (const key of [
    "command",
    "path",
    "file",
    "pattern",
    "query",
    "url",
    "title",
    "question",
    "objective",
    "prompt",
    "description",
    "text",
    "name",
  ]) {
    const v = o[key]
    if (typeof v === "string" && v.trim()) return oneLine(v).slice(0, 96)
  }
  try {
    return oneLine(JSON.stringify(input)).slice(0, 80)
  } catch {
    return undefined
  }
}

/** How many lines of live tool progress to keep on screen while a tool runs.
 *  A tail, not a log — mirrors TOOL_PROGRESS_TAIL_LINES in the TUI. */
const TOOL_PROGRESS_TAIL_LINES = 6

/** Last N lines of streamed progress, for the live tail view. */
function progressTail(progress: string): string[] {
  const lines = progress.split("\n")
  // A trailing newline yields a final "" that would render as a blank row and
  // make the tail look like it's stalling — drop it, but keep interior blanks.
  if (lines[lines.length - 1] === "") lines.pop()
  return lines.slice(-TOOL_PROGRESS_TAIL_LINES)
}

/** Live tails for every tool in a group that is currently streaming progress.
 *
 *  Rendered as a sibling BELOW <ChatToolCalls> rather than via each call's
 *  `resultDetail`, because the design system only reveals resultDetail on click
 *  (and, in a multi-call group, only renders the per-call rows once expanded) —
 *  a live tail has to be visible without interaction. Keyed by tool id, so
 *  concurrently streaming tools each get their own tail. */
function ToolProgressTails({ tools }: { tools: ToolItem[] }) {
  const streaming = tools.filter((t) => !t.done && t.progress)
  if (streaming.length === 0) return null
  return (
    <>
      {streaming.map((t) => (
        <pre key={t.id} className="chunky-tool-progress">
          {progressTail(t.progress!).join("\n")}
        </pre>
      ))}
    </>
  )
}

function toToolCall(item: ToolItem): ChatToolCallItem {
  return {
    key: item.id,
    name: item.name,
    status: item.done ? (item.ok === false ? "error" : "complete") : "running",
    target: toolTarget(item.input),
    errorMessage: item.done && item.ok === false ? item.output : undefined,
    resultDetail:
      item.done && item.output ? (
        <pre className="chunky-tool-detail">{item.output}</pre>
      ) : undefined,
  }
}

type Sender = "user" | "assistant" | "system"

function senderOf(g: Group): Sender {
  if (g.type === "tools") return "assistant"
  switch (g.item.kind) {
    case "user":
      return "user"
    case "cache-warning":
    case "goal":
    case "notice":
    case "workflow-phase":
    case "workflow-log":
      return "system"
    default:
      return "assistant"
  }
}

/** Chunky's gorilla mark, shown at the start of each assistant burst. */
function ChunkyAvatar() {
  return (
    <span className="chunky-avatar" aria-hidden="true">
      <img className="chunky-mark" src="/chunky-mark.png" alt="" />
    </span>
  )
}

/** Keeps continuation rows aligned under the burst's avatar without repeating it. */
function AvatarSpacer() {
  return <span className="chunky-avatar-spacer" aria-hidden="true" />
}

/** Render a run of grouped items as chat messages, with avatar/burst logic scoped
 *  to this run (a thread block naturally breaks a burst). */
function MessageGroups({ groups, isMain }: { groups: Group[]; isMain: boolean }) {
  const copyMessage = useCallback((text: string) => void navigator.clipboard.writeText(text), [])
  const senders = groups.map(senderOf)
  return (
    <>
      {groups.map((g, i) => {
        // First row of a same-sender run gets the avatar + name; the rest align under it.
        const burstStart = senders[i] !== senders[i - 1]
        const assistant = {
          sender: "assistant" as const,
          avatar: burstStart ? <ChunkyAvatar /> : <AvatarSpacer />,
          name: burstStart ? "Chunky" : undefined,
        }

        if (g.type === "tools") {
          return (
            <ChatMessage key={`tools-${i}`} {...assistant}>
              <ChatToolCalls calls={g.tools.map(toToolCall)} />
              <ToolProgressTails tools={g.tools} />
            </ChatMessage>
          )
        }

        const item = g.item
        switch (item.kind) {
          case "user":
            return (
              // Main-thread prompts carry the minimap's anchor class (see
              // lib/minimap.ts): className is the one prop ChatMessage actually
              // forwards to its root element. Child-thread prompts stay unmarked —
              // they live inside collapsible blocks with no stable position.
              <ChatMessage
                key={`u-${i}`}
                sender="user"
                className={isMain ? USER_ANCHOR_CLASS : undefined}
              >
                <ChatMessageBubble
                  name={burstStart ? <span className="chunky-sender">You</span> : undefined}
                >
                  {item.from ? (
                    // Injected by ANOTHER session via send_to_session — show
                    // provenance so it doesn't read as something the user typed.
                    <span className="chunky-user-from">⇄ from session {item.from}</span>
                  ) : null}
                  {item.text}
                </ChatMessageBubble>
              </ChatMessage>
            )
          case "assistant":
            return (
              <ChatMessage key={`a-${i}`} {...assistant}>
                <ChatMessageBubble variant="ghost">
                  {item.text ? (
                    <Markdown isStreaming={item.streaming} components={MARKDOWN_COMPONENTS}>
                      {item.text}
                    </Markdown>
                  ) : item.streaming ? (
                    <span className="chunky-thinking">Chunky's thinking…</span>
                  ) : null}
                  {item.text && !item.streaming ? (
                    <button
                      className="chunky-copy-message"
                      type="button"
                      title="Copy message"
                      aria-label="Copy assistant message"
                      onClick={() => copyMessage(item.text)}
                    >
                      Copy
                    </button>
                  ) : null}
                  {item.endReason === "max_tokens" ? (
                    <div className="chunky-response-warning">⚠ Response stopped at the output limit.</div>
                  ) : null}
                  {item.endReason === "interrupted" ? (
                    <div className="chunky-response-warning">⏹ Response interrupted.</div>
                  ) : null}
                  {item.endReason === "error" ? (
                    <div className="chunky-callout-error">Response ended unexpectedly — see the error below for details.</div>
                  ) : null}
                </ChatMessageBubble>
              </ChatMessage>
            )
          case "error":
            return (
              <ChatMessage key={`e-${i}`} {...assistant}>
                <div className="chunky-callout-error" role="alert">
                  {item.text}
                </div>
              </ChatMessage>
            )
          case "cache-warning":
            return (
              <ChatSystemMessage key={`c-${i}`}>
                {item.reason === "idle"
                  ? `Prompt cache went cold after idle${item.idleMs != null ? ` (~${Math.round(item.idleMs / 1000)}s)` : ""}. ~${item.approxTokens.toLocaleString()} tokens will be re-sent.`
                  : `Model switched${item.fromModel ? ` from ${item.fromModel}` : ""}${item.toModel ? ` to ${item.toModel}` : ""}. Cache invalidated (~${item.approxTokens.toLocaleString()} tokens).`}
              </ChatSystemMessage>
            )
          case "goal":
            return (
              <ChatSystemMessage key={`g-${i}`} variant="divider">
                {item.message}
              </ChatSystemMessage>
            )
          case "notice":
            // Multi-line notices are tables (/scoreboard, /usage) — the default
            // system line is centered + nowrap, so those get a monospace block.
            return (
              <ChatSystemMessage key={`n-${i}`}>
                {item.text.includes("\n") ? (
                  <pre className="chunky-notice-block">{item.text}</pre>
                ) : (
                  item.text
                )}
              </ChatSystemMessage>
            )
          case "workflow-phase":
            return (
              <ChatSystemMessage key={`wp-${i}`} variant="divider">
                {item.title}
              </ChatSystemMessage>
            )
          case "workflow-log":
            return (
              <ChatSystemMessage key={`wl-${i}`}>
                <span className="chunky-workflow-log">{item.message}</span>
              </ChatSystemMessage>
            )
          default:
            return null
        }
      })}
    </>
  )
}

/**
 * Render a parent thread's OWN items with its child-thread blocks interleaved at
 * each child's spawn anchor, so the stream reads in true chronological order — a
 * parent's post-spawn output (e.g. its final summary) sits BELOW the threads that
 * produced it, not above. Recurses through ThreadBlock for nested threads.
 */
function ParentBody({
  items,
  parentId,
  state,
  depth,
  expanded,
  onToggle,
}: {
  items: Item[]
  parentId: string
  state: TranscriptState
  depth: number
  expanded: Set<string>
  onToggle: (id: string) => void
}) {
  const plan = buildRenderPlan(items, childrenOf(state, parentId))
  return (
    <>
      {plan.map((node, i) => (
        <Fragment key={i}>
          {node.kind === "items" ? (
            <MessageGroups groups={node.groups} isMain={parentId === MAIN} />
          ) : (
            node.threads.map((thread) => (
              <ThreadBlock
                key={thread.id}
                thread={thread}
                state={state}
                depth={depth}
                expanded={expanded}
                onToggle={onToggle}
              />
            ))
          )}
        </Fragment>
      ))}
    </>
  )
}

/** One child thread: a colour-railed block with a clickable header that expands
 *  from a one-line preview to the thread's full (recursively interleaved) body. */
function ThreadBlock({
  thread,
  state,
  depth,
  expanded,
  onToggle,
}: {
  thread: ThreadNode
  state: TranscriptState
  depth: number
  expanded: Set<string>
  onToggle: (id: string) => void
}) {
  const running = thread.status === "running"
  const isExpanded = expanded.has(thread.id)
  const childCount = childrenOf(state, thread.id).length
  const countLabel = `${thread.items.length} item${thread.items.length === 1 ? "" : "s"}${
    childCount > 0 ? ` · ${childCount} sub` : ""
  }`
  const preview = isExpanded ? null : threadPreview(thread.items)

  return (
    <div className="chunky-subthread" data-depth={depth % 2} data-running={running || undefined}>
      <button
        type="button"
        className="chunky-subthread-head"
        onClick={() => onToggle(thread.id)}
        aria-expanded={isExpanded}
      >
        <span className="chunky-subthread-caret" aria-hidden="true">
          {isExpanded ? "▾" : "▸"}
        </span>
        <span
          className="chunky-subthread-dot"
          data-running={running || undefined}
          aria-hidden="true"
        />
        <span className="chunky-subthread-title">{thread.title}</span>
        {thread.model ? <span className="chunky-subthread-model">{thread.model}</span> : null}
        <span className="chunky-subthread-status">{running ? "running…" : "done"}</span>
        <span className="chunky-subthread-count">{countLabel}</span>
      </button>

      {isExpanded ? (
        <div className="chunky-subthread-body">
          <ParentBody
            items={thread.items}
            parentId={thread.id}
            state={state}
            depth={depth + 1}
            expanded={expanded}
            onToggle={onToggle}
          />
        </div>
      ) : (
        <div className="chunky-subthread-preview">
          {preview && preview.text ? (
            <>
              {preview.text}
              {preview.more > 0 ? (
                <span className="chunky-subthread-more"> +{preview.more} more</span>
              ) : null}
            </>
          ) : (
            <span className="chunky-subthread-more">
              {countLabel}
              {running ? " …" : ""}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

export function TranscriptView({ state }: { state: TranscriptState }) {
  const stateRef = useRef(state)
  stateRef.current = state
  const openInBrowser = useOpenInBrowser()

  // Links in rendered markdown open in the built-in browser pane. Handled by
  // delegation on the transcript root rather than a Markdown `components.a`
  // override: MARKDOWN_COMPONENTS is frozen at module scope precisely because a
  // changing identity re-parses every block on every streamed delta, and this
  // handler would have to close over `openInBrowser`.
  const onLinkClick = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      // Let modified clicks keep their platform meaning (new window, download,
      // context menu) instead of hijacking them into the pane.
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
      const anchor = (e.target as HTMLElement | null)?.closest?.("a[href]")
      if (!(anchor instanceof HTMLAnchorElement)) return
      // `href` resolves relative URLs against the document; only absolute
      // http(s) links belong in the pane. Anything else (mailto:, in-page
      // anchors) keeps its default behaviour.
      if (!isHttpUrl(anchor.href)) return
      e.preventDefault()
      openInBrowser(anchor.href)
    },
    [openInBrowser],
  )
  // Per-thread expand state so a fan-out of spawned threads can't flood the view:
  // every child renders as a one-line preview by default and expands on click.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const onToggle = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  // Ctrl+Shift+C copies the latest main-thread assistant reply. The per-message
  // Copy button remains available for older replies and child threads.
  useEffect(() => {
    const onCopy = (e: KeyboardEvent) => {
      if (!e.ctrlKey || !e.shiftKey || e.metaKey || e.altKey || e.key.toLowerCase() !== "c") return
      const latest = [...(stateRef.current.threads[MAIN]?.items ?? [])]
        .reverse()
        .find((item) => item.kind === "assistant" && item.text.trim())
      if (latest?.kind !== "assistant") return
      e.preventDefault()
      void navigator.clipboard.writeText(latest.text)
    }
    document.addEventListener("keydown", onCopy)
    return () => document.removeEventListener("keydown", onCopy)
  }, [])

  // Ctrl+T folds every expanded thread back to its preview line (TUI parity).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.metaKey && !e.altKey && (e.key === "t" || e.key === "T")) {
        const target = e.target
        if (target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return
        e.preventDefault()
        setExpanded(new Set())
      }
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [])

  const main = state.threads[MAIN]
  if (!main) return null

  return (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- delegation
    // target for anchors, which are themselves focusable and keyboard-activatable.
    <div className="chunky-transcript" onClick={onLinkClick}>
      <ChatMessageList gap={5}>
        <ParentBody
          items={main.items}
          parentId={MAIN}
          state={state}
          depth={0}
          expanded={expanded}
          onToggle={onToggle}
        />
      </ChatMessageList>
    </div>
  )
}
