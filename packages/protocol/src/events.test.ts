import { describe, expect, test } from "bun:test"
import type { AgentEvent, QueueEntry } from "./index.ts"

describe("queue and interjection protocol events", () => {
  test("queue.changed carries authoritative ordered entries", () => {
    const entry: QueueEntry = {
      id: "q-1",
      version: 1,
      text: "model prompt",
      shown: "visible prompt",
      kind: "prompt",
      position: 0,
      createdAt: 1,
    }
    const event: AgentEvent = {
      type: "queue.changed",
      sessionId: "s-1",
      entries: [entry],
      running: true,
    }
    expect(event.entries[0]).toEqual(entry)
  })

  test("message.interjection distinguishes acceptance from injection", () => {
    const accepted: AgentEvent = {
      type: "message.interjection",
      sessionId: "s-1",
      text: "change course",
      injected: false,
    }
    const injected: AgentEvent = { ...accepted, injected: true }
    expect([accepted.injected, injected.injected]).toEqual([false, true])
  })
})
