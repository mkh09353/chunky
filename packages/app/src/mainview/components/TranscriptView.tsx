import { Fragment, useCallback, useState } from "react"
import {
  ChatMessage,
  ChatMessageBubble,
  ChatMessageList,
  ChatSystemMessage,
  ChatToolCalls,
  type ChatToolCallItem,
} from "@astryxdesign/core/Chat"
import { Markdown } from "@astryxdesign/core/Markdown"
import type { Item, ThreadNode, TranscriptState } from "../lib/transcript"
import { MAIN } from "../lib/transcript"
import {
  buildRenderPlan,
  childrenOf,
  threadPreview,
  type Group,
  type ToolItem,
} from "../lib/renderPlan"

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
function MessageGroups({ groups }: { groups: Group[] }) {
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
            </ChatMessage>
          )
        }

        const item = g.item
        switch (item.kind) {
          case "user":
            return (
              <ChatMessage key={`u-${i}`} sender="user">
                <ChatMessageBubble
                  name={burstStart ? <span className="chunky-sender">You</span> : undefined}
                >
                  {item.text}
                </ChatMessageBubble>
              </ChatMessage>
            )
          case "assistant":
            return (
              <ChatMessage key={`a-${i}`} {...assistant}>
                <ChatMessageBubble variant="ghost">
                  {item.text ? (
                    <Markdown isStreaming={item.streaming}>{item.text}</Markdown>
                  ) : item.streaming ? (
                    <span className="chunky-thinking">Chunky's thinking…</span>
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
            return <ChatSystemMessage key={`n-${i}`}>{item.text}</ChatSystemMessage>
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
            <MessageGroups groups={node.groups} />
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

  const main = state.threads[MAIN]
  if (!main) return null

  return (
    <div className="chunky-transcript">
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
