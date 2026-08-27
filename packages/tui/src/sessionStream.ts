import {
  encodeSessionEventCursor,
  type AgentEvent,
  type SessionEventStreamFrame,
} from "@chunky/protocol"
import { initialState, pushUser, reduce, type TranscriptState } from "./transcript.js"

export type SessionStreamFrame = SessionEventStreamFrame | { kind: "legacy"; event: AgentEvent }
export type SessionStreamStep =
  | { kind: "replay-event"; event: AgentEvent }
  | { kind: "visible"; event: AgentEvent }
  | { kind: "durable"; event: AgentEvent }
  | { kind: "commit"; state: TranscriptState; durable: TranscriptState; cursor: string }
  | { kind: "reset"; reason: "history-rewritten" | "cursor-ahead" }
  | { kind: "legacy"; event: AgentEvent }

export interface CommittedSessionStream {
  durable: TranscriptState
  cursor: string
}

/** Persisted own-user events need the replay-only echo that the normal live
 * reducer intentionally omits to avoid duplicating optimistic sends. */
function reduceDurable(state: TranscriptState, event: AgentEvent): TranscriptState {
  if (event.type === "message.user" && !event.from) return pushUser(state, event.text)
  if (event.type === "message.interjection" && !event.injected) return pushUser(state, event.text)
  return reduce(state, event)
}

/** One v2 connection attempt. Throw it away if EOF arrives before replay-end. */
export class SessionStreamMachine {
  private durableState: TranscriptState
  private working: TranscriptState
  private cursorValue: string | null
  private live = false

  constructor(committed?: CommittedSessionStream | null) {
    this.durableState = committed?.durable ?? initialState
    this.working = this.durableState
    this.cursorValue = committed?.cursor ?? null
  }

  get requestCursor(): string | null { return this.cursorValue }
  get replayComplete(): boolean { return this.live }
  get durable(): TranscriptState { return this.durableState }
  get cursor(): string | null { return this.cursorValue }

  handle(frame: SessionStreamFrame): SessionStreamStep {
    if (frame.kind === "legacy") return { kind: "legacy", event: frame.event }
    if (frame.kind === "replay-reset") {
      this.working = initialState
      return { kind: "reset", reason: frame.reason }
    }
    if (frame.kind === "replay-end") {
      this.durableState = this.working
      this.cursorValue = encodeSessionEventCursor(frame.cursor)
      this.live = true
      return { kind: "commit", state: this.durableState, durable: this.durableState, cursor: this.cursorValue }
    }
    if (frame.kind === "live") return { kind: "visible", event: frame.event }
    if (!this.live) {
      this.working = reduceDurable(this.working, frame.event)
      return { kind: "replay-event", event: frame.event }
    }
    this.durableState = reduceDurable(this.durableState, frame.event)
    this.cursorValue = encodeSessionEventCursor(frame.cursor)
    if (frame.event.type === "message.delta") return { kind: "durable", event: frame.event }
    return { kind: "visible", event: frame.event }
  }
}
