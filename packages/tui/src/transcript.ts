// Reduce a stream of AgentEvents into flat, renderable transcript items.
import type { AgentEvent } from "@mc/protocol"

export type Item =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; streaming: boolean }
  | { kind: "tool"; id: string; name: string; input: unknown; done: boolean; ok?: boolean; output?: string }
  | { kind: "error"; text: string }

export interface TranscriptState {
  items: Item[]
  status: "idle" | "running"
}

export const initialState: TranscriptState = { items: [], status: "idle" }

/** Pure reducer: fold one AgentEvent into the transcript. Tolerates thread.* events. */
export function reduce(state: TranscriptState, ev: AgentEvent): TranscriptState {
  switch (ev.type) {
    case "session.status":
      return { ...state, status: ev.status }

    case "message.start":
      return { ...state, items: [...state.items, { kind: "assistant", text: "", streaming: true }] }

    case "message.delta": {
      const items = [...state.items]
      // Append to the last streaming assistant item, or open one if the
      // server streamed deltas without an explicit message.start.
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i]!
        if (it.kind === "assistant" && it.streaming) {
          items[i] = { ...it, text: it.text + ev.text }
          return { ...state, items }
        }
      }
      return { ...state, items: [...items, { kind: "assistant", text: ev.text, streaming: true }] }
    }

    case "message.end": {
      const items = [...state.items]
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i]!
        if (it.kind === "assistant" && it.streaming) {
          items[i] = { ...it, streaming: false }
          break
        }
      }
      return { ...state, items }
    }

    case "tool.start": {
      // Close any open assistant block so text streamed after the tool
      // interleaves *below* it, the way Claude Code renders turns.
      const items = state.items.map((it) =>
        it.kind === "assistant" && it.streaming ? { ...it, streaming: false } : it,
      )
      return {
        ...state,
        items: [...items, { kind: "tool", id: ev.id, name: ev.name, input: ev.input, done: false }],
      }
    }

    case "tool.end": {
      const items = state.items.map((it) =>
        it.kind === "tool" && it.id === ev.id ? { ...it, done: true, ok: ev.ok, output: ev.output } : it,
      )
      return { ...state, items }
    }

    case "error":
      return { ...state, items: [...state.items, { kind: "error", text: ev.message }] }

    // thread.* — tolerated, ignored for the v0 single-thread prototype.
    default:
      return state
  }
}

export function pushUser(state: TranscriptState, text: string): TranscriptState {
  return { ...state, items: [...state.items, { kind: "user", text }] }
}
