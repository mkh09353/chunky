import type { AgentEvent } from "@chunky/protocol"

type BufferState = { text: string; flushed: number; threadId?: string }
export const MESSAGE_FLUSH_BYTES = 8 * 1024

export function createMessageCoalescer(persist: (sessionId: string, event: AgentEvent) => void) {
  const buffers = new Map<string, BufferState>()
  const key = (sessionId: string, ev: AgentEvent) => `${sessionId}:${("threadId" in ev && ev.threadId) || "root"}`
  const flush = (sessionId: string, ev: AgentEvent, final = false) => {
    const k = key(sessionId, ev), buffer = buffers.get(k)
    if (!buffer) return
    const chunk = buffer.text.slice(buffer.flushed)
    if (chunk || final) persist(sessionId, { type: "message.delta", text: chunk, ...(buffer.threadId ? { threadId: buffer.threadId } : {}) })
    buffer.flushed = buffer.text.length
    if (final) buffers.delete(k)
  }
  return (sessionId: string, ev: AgentEvent): void => {
    if (ev.type === "message.start") {
      for (const buffer of buffers.values()) if (buffer.text.length > buffer.flushed) flush(sessionId, { type: "message.delta", text: "", ...(buffer.threadId ? { threadId: buffer.threadId } : {}) })
      buffers.set(key(sessionId, ev), { text: "", flushed: 0, threadId: "threadId" in ev ? ev.threadId : undefined })
      persist(sessionId, ev)
    } else if (ev.type === "message.delta") {
      const k = key(sessionId, ev), buffer = buffers.get(k) ?? { text: "", flushed: 0, threadId: "threadId" in ev ? ev.threadId : undefined }
      buffer.text += ev.text; buffers.set(k, buffer)
      if (Buffer.byteLength(buffer.text.slice(buffer.flushed)) >= MESSAGE_FLUSH_BYTES) flush(sessionId, ev)
    } else {
      if (ev.type === "message.end") flush(sessionId, ev, true)
      else for (const buffer of buffers.values()) if (buffer.text.length > buffer.flushed) flush(sessionId, { type: "message.delta", text: "", ...(buffer.threadId ? { threadId: buffer.threadId } : {}) })
      persist(sessionId, ev)
    }
  }
}
