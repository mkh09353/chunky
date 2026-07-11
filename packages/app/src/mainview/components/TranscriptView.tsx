import {
  ChatMessage,
  ChatMessageBubble,
  ChatMessageList,
  ChatSystemMessage,
  ChatToolCalls,
  type ChatToolCallItem,
} from "@astryxdesign/core/Chat"
import { Markdown } from "@astryxdesign/core/Markdown"
import type { Item } from "../lib/transcript"

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

function toToolCall(item: Extract<Item, { kind: "tool" }>): ChatToolCallItem {
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

type Group =
  | { type: "item"; item: Item }
  | { type: "tools"; tools: Extract<Item, { kind: "tool" }>[] }

/** Collapse consecutive tool items into one ChatToolCalls group for cleaner UI. */
function groupItems(items: Item[]): Group[] {
  const out: Group[] = []
  let toolBuf: Extract<Item, { kind: "tool" }>[] = []

  const flush = () => {
    if (toolBuf.length) {
      out.push({ type: "tools", tools: toolBuf })
      toolBuf = []
    }
  }

  for (const item of items) {
    if (item.kind === "tool") {
      toolBuf.push(item)
    } else {
      flush()
      out.push({ type: "item", item })
    }
  }
  flush()
  return out
}

type Sender = "user" | "assistant" | "system"

function senderOf(g: Group): Sender {
  if (g.type === "tools") return "assistant"
  switch (g.item.kind) {
    case "user":
      return "user"
    case "cache-warning":
    case "goal":
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

export function TranscriptView({ items }: { items: Item[] }) {
  const groups = groupItems(items)
  const senders = groups.map(senderOf)

  return (
    <div className="chunky-transcript">
      <ChatMessageList gap={5}>
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
            default:
              return null
          }
        })}
      </ChatMessageList>
    </div>
  )
}
