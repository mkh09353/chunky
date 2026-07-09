// Streaming translation: run the DeepAgents agent and translate LangGraph JS v1
// stream items into protocol AgentEvents. Verified empirically against GLM-5.2.
import type { AgentEvent } from "@mc/protocol"
import { agent } from "./agent.ts"

type Emit = (ev: AgentEvent) => void

// Extract plain text from an AIMessageChunk `content`, which is either a string
// or an array of content blocks (we only care about text blocks).
function contentToText(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    let out = ""
    for (const part of content) {
      if (typeof part === "string") out += part
      else if (part && typeof part === "object") {
        const p = part as Record<string, unknown>
        if (p.type === "text" && typeof p.text === "string") out += p.text
      }
    }
    return out
  }
  return ""
}

function getType(msg: any): string {
  if (!msg || typeof msg !== "object") return ""
  if (typeof msg.getType === "function") return msg.getType()
  if (typeof msg._getType === "function") return msg._getType()
  return msg.type ?? ""
}

/**
 * Run one agent turn for `text` on thread `sessionId`, emitting AgentEvents.
 * Emits session.status running/idle around the run, message.start/delta/end for
 * assistant text, and tool.start/tool.end for tool calls (best-effort).
 */
export async function runAgent(sessionId: string, text: string, emit: Emit): Promise<void> {
  emit({ type: "session.status", sessionId, status: "running" })

  let assistantOpen = false
  const seenToolStart = new Set<string>()
  const seenToolEnd = new Set<string>()

  const openAssistant = () => {
    if (!assistantOpen) {
      assistantOpen = true
      emit({ type: "message.start", role: "assistant" })
    }
  }
  const closeAssistant = () => {
    if (assistantOpen) {
      assistantOpen = false
      emit({ type: "message.end" })
    }
  }

  try {
    const stream = await agent.stream(
      { messages: [{ role: "user", content: text }] },
      {
        configurable: { thread_id: sessionId },
        streamMode: ["updates", "messages"],
      } as any,
    )

    for await (const item of stream as AsyncIterable<[string, unknown]>) {
      const [mode, data] = item

      if (mode === "messages") {
        // data === [messageChunk, metadata]
        const [chunk] = data as [any, unknown]
        if (getType(chunk) === "ai") {
          const t = contentToText(chunk?.content)
          if (t) {
            openAssistant()
            emit({ type: "message.delta", text: t })
          }
        }
        continue
      }

      if (mode === "updates") {
        // data === { nodeName: { messages?: BaseMessage[], ... }, ... }
        const updates = data as Record<string, any>
        if (!updates || typeof updates !== "object") continue
        for (const nodeUpdate of Object.values(updates)) {
          const messages = nodeUpdate?.messages
          if (!Array.isArray(messages)) continue
          for (const msg of messages) {
            const kind = getType(msg)
            if (kind === "ai") {
              // A completed assistant message closes any open streamed text turn.
              closeAssistant()
              const toolCalls = msg?.tool_calls
              if (Array.isArray(toolCalls)) {
                for (const tc of toolCalls) {
                  const id = tc?.id ?? `${tc?.name}:${JSON.stringify(tc?.args)}`
                  if (seenToolStart.has(id)) continue
                  seenToolStart.add(id)
                  emit({
                    type: "tool.start",
                    id,
                    name: tc?.name ?? "unknown",
                    input: tc?.args ?? {},
                  })
                }
              }
            } else if (kind === "tool") {
              const id = msg?.tool_call_id ?? msg?.id ?? "unknown"
              if (seenToolEnd.has(id)) continue
              seenToolEnd.add(id)
              const output =
                typeof msg?.content === "string" ? msg.content : contentToText(msg?.content)
              emit({
                type: "tool.end",
                id,
                ok: msg?.status !== "error",
                output,
              })
            }
          }
        }
        continue
      }
    }

    closeAssistant()
  } catch (err) {
    closeAssistant()
    emit({ type: "error", message: (err as Error)?.message ?? String(err) })
  } finally {
    emit({ type: "session.status", sessionId, status: "idle" })
  }
}
