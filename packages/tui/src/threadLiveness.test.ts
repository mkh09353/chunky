import { describe, expect, test } from "bun:test"
import type { AgentEvent } from "@chunky/protocol"
import { initialState, reduce, replayHistory } from "./transcript.js"

const spawn = (id: string): AgentEvent =>
  ({ type: "thread.spawn", threadId: id, title: id }) as AgentEvent
const progress = (id: string): AgentEvent =>
  ({ type: "tool.progress", threadId: id, id: "t1", chunk: "x" }) as AgentEvent
const status = (id: string, s: "idle" | "running"): AgentEvent =>
  ({ type: "thread.status", threadId: id, status: s }) as AgentEvent

describe("child thread liveness clocks", () => {
  test("spawn stamps startedAt/lastEventAt while running", () => {
    const state = reduce(initialState, spawn("c1"))
    const node = state.threads.c1!
    expect(node.status).toBe("running")
    expect(node.startedAt).toBeNumber()
    expect(node.lastEventAt).toBeNumber()
  })

  test("any routed child event bumps lastEventAt but keeps startedAt", async () => {
    const spawned = reduce(initialState, spawn("c1"))
    const started = spawned.threads.c1!.startedAt
    await Bun.sleep(5)
    const after = reduce(spawned, progress("c1"))
    expect(after.threads.c1!.startedAt).toBe(started!)
    expect(after.threads.c1!.lastEventAt!).toBeGreaterThan(spawned.threads.c1!.lastEventAt!)
  })

  test("leaving running CLEARS the clocks so done/replayed threads render as before", () => {
    const done = replayHistory([spawn("c1"), progress("c1"), status("c1", "idle")])
    const node = done.threads.c1!
    expect(node.status).toBe("idle")
    expect(node.startedAt).toBeUndefined()
    expect(node.lastEventAt).toBeUndefined()
  })
})
