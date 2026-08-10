import { describe, expect, test } from "bun:test"
import type { AgentEvent, ModeSpec, QueueEntry } from "./index.ts"

describe("ports protocol events", () => {
  test("ports.changed carries an authoritative listening-port snapshot", () => {
    const event: AgentEvent = { type: "ports.changed", sessionId: "s-1", ports: [
      { port: 3000, address: "127.0.0.1", pid: 42, command: "node", taskId: "task-1", url: "http://localhost:3000/" },
    ] }
    expect(event.ports[0]).toEqual({ port: 3000, address: "127.0.0.1", pid: 42, command: "node", taskId: "task-1", url: "http://localhost:3000/" })
  })
})

describe("queue and interjection protocol events", () => {
  test("mode.applied carries the saved mode name and full spec", () => {
    const spec: ModeSpec = { provider: "zen", model: "glm-5" }
    const event: AgentEvent = { type: "mode.applied", name: "fire", spec }
    expect(event).toEqual({ type: "mode.applied", name: "fire", spec })
  })

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
