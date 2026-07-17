import { describe, expect, test } from "bun:test"
import type { AgentEvent } from "@chunky/protocol"
import { MAIN, initialState, reduce, type Item } from "./transcript"

/** Fold a list of events into main-thread items. */
function items(evs: AgentEvent[]): Item[] {
  return evs.reduce(reduce, initialState).threads[MAIN]!.items
}

function tools(evs: AgentEvent[]): Extract<Item, { kind: "tool" }>[] {
  return items(evs).filter((it): it is Extract<Item, { kind: "tool" }> => it.kind === "tool")
}

const start = (id: string, name = "bash"): AgentEvent => ({ type: "tool.start", id, name, input: {} })
const progress = (id: string, chunk: string): AgentEvent => ({ type: "tool.progress", id, chunk })
const end = (id: string, output: string): AgentEvent => ({ type: "tool.end", id, ok: true, output })

describe("tool.progress reducer", () => {
  test("chunks append to the matching tool item", () => {
    const [tool] = tools([start("t1"), progress("t1", "line 1\n"), progress("t1", "line 2\n")])
    expect(tool!.progress).toBe("line 1\nline 2\n")
    expect(tool!.done).toBe(false)
  })

  test("tool.end output REPLACES accumulated progress", () => {
    const [tool] = tools([start("t1"), progress("t1", "noise\nmore noise\n"), end("t1", "final result")])
    expect(tool!.progress).toBeUndefined()
    expect(tool!.output).toBe("final result")
    expect(tool!.done).toBe(true)
  })

  test("concurrent tools stream independently, keyed strictly by id", () => {
    const [a, b] = tools([
      start("t1", "bash"),
      start("t2", "read"),
      progress("t1", "from one\n"),
      progress("t2", "from two\n"),
      progress("t1", "one again\n"),
    ])
    expect(a!.progress).toBe("from one\none again\n")
    expect(b!.progress).toBe("from two\n")
  })

  test("a chunk for an unknown id is ignored (arrives after reconnect)", () => {
    const before = items([start("t1")])
    const after = items([start("t1"), progress("ghost", "who?")])
    expect(after).toEqual(before)
  })

  test("a late chunk never overwrites a finished tool's output", () => {
    const [tool] = tools([start("t1"), end("t1", "final"), progress("t1", "late straggler")])
    expect(tool!.progress).toBeUndefined()
    expect(tool!.output).toBe("final")
  })

  test("accumulated progress is capped at 64KB, dropping the OLDEST bytes", () => {
    const chunk = "x".repeat(10_000)
    const evs: AgentEvent[] = [start("t1")]
    for (let i = 0; i < 10; i++) evs.push(progress("t1", chunk))
    evs.push(progress("t1", "TAIL"))
    const [tool] = tools(evs)
    expect(tool!.progress!.length).toBe(64 * 1024)
    expect(tool!.progress!.endsWith("TAIL")).toBe(true)
  })

  test("progress is live-only: a history replay without it renders the same rows", () => {
    // The server never persists tool.progress, so replayed history goes
    // start → end with no progress in between.
    const replayed = [start("t1"), end("t1", "final")].reduce(reduce, initialState)
    const live = [start("t1"), progress("t1", "chatter\n"), end("t1", "final")].reduce(reduce, initialState)
    expect(replayed).toEqual(live)
  })

  test("progress routes to the owning thread, not main", () => {
    const evs: AgentEvent[] = [
      { type: "tool.start", id: "t1", name: "bash", input: {}, threadId: "child" },
      { type: "tool.progress", id: "t1", chunk: "hi\n", threadId: "child" },
    ]
    const state = evs.reduce(reduce, initialState)
    const child = state.threads["child"]!.items[0] as Extract<Item, { kind: "tool" }>
    expect(child.progress).toBe("hi\n")
    expect(state.threads[MAIN]!.items).toEqual([])
  })
})
