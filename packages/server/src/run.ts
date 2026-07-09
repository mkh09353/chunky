// Streaming translation: run the DeepAgents agent and translate LangGraph JS v1
// stream items into protocol AgentEvents. Verified empirically against GLM-5.2.
//
// The core translation lives in `translateStream(stream, threadId, emit)` so the
// SAME logic drives the main session run AND every spawned child thread (see
// threads.ts). Events are tagged with `threadId` for children; the main thread
// omits it (so the wire is identical to the pre-threads prototype).
import type { AgentEvent } from "@mc/protocol"
import { getAgent } from "./agent.ts"
import { ThreadManager } from "./threads.ts"

export type Emit = (ev: AgentEvent) => void

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
 * Translate one LangGraph stream (streamMode ["updates","messages"]) into
 * AgentEvents, emitting message.start/delta/end for assistant text and
 * tool.start/tool.end for tool calls. Every emitted event is tagged with
 * `threadId` when one is supplied (child threads); pass `undefined` for the
 * main session thread to keep events untagged. Returns the accumulated
 * assistant text so a child thread can hand its final answer back to its caller.
 */
export async function translateStream(
  // The concrete LangGraph stream type is provider/graph-specific; we consume it
  // structurally as ["updates"|"messages", data] tuples.
  stream: AsyncIterable<unknown>,
  threadId: string | undefined,
  emit: Emit,
): Promise<string> {
  // Tag message/tool/error events with the owning threadId (omitted for main).
  const emitT = (ev: AgentEvent) => emit(threadId ? ({ ...ev, threadId } as AgentEvent) : ev)

  let assistantOpen = false
  let finalText = ""
  const seenToolStart = new Set<string>()
  const seenToolEnd = new Set<string>()

  const openAssistant = () => {
    if (!assistantOpen) {
      assistantOpen = true
      emitT({ type: "message.start", role: "assistant" })
    }
  }
  const closeAssistant = () => {
    if (assistantOpen) {
      assistantOpen = false
      emitT({ type: "message.end" })
    }
  }

  try {
    for await (const item of stream as AsyncIterable<[string, unknown]>) {
      const [mode, data] = item

      if (mode === "messages") {
        // data === [messageChunk, metadata]
        const [chunk] = data as [any, unknown]
        if (getType(chunk) === "ai") {
          const t = contentToText(chunk?.content)
          if (t) {
            openAssistant()
            finalText += t
            emitT({ type: "message.delta", text: t })
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
                  emitT({
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
              emitT({
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
  } finally {
    closeAssistant()
  }

  return finalText
}

/**
 * Run one agent turn for `text` on thread `sessionId`, emitting AgentEvents.
 * This is the MAIN session thread: its message/tool events are untagged, and it
 * installs a ThreadManager (registered under `sessionId`) so the model can call
 * the `spawn_thread` tool to launch real, independent, streamable child threads.
 * Signature is intentionally unchanged — index.ts calls this.
 */
export async function runAgent(sessionId: string, text: string, emit: Emit): Promise<void> {
  emit({ type: "session.status", sessionId, status: "running" })

  // Context for spawn_thread: any thread_id in this run (root or descendant)
  // resolves back to this manager via the thread registry.
  const threads = new ThreadManager(emit, sessionId)

  try {
    const stream = await getAgent().stream(
      { messages: [{ role: "user", content: text }] },
      {
        configurable: { thread_id: sessionId },
        streamMode: ["updates", "messages"],
      } as any,
    )

    await translateStream(stream, undefined, emit)
  } catch (err) {
    emit({ type: "error", message: (err as Error)?.message ?? String(err) })
  } finally {
    threads.dispose()
    emit({ type: "session.status", sessionId, status: "idle" })
  }
}
