import { describe, expect, test } from "bun:test"
import { decodeSessionEventCursor, type SessionEventStreamFrame } from "@chunky/protocol"
import { initialState } from "./transcript.js"
import { SessionStreamMachine } from "./sessionStream.js"

describe("TUI session stream machine", () => {
  test("commits replay atomically and resumes only the suffix", () => {
    const generation = "g"
    const first = new SessionStreamMachine()
    first.handle({ kind: "event", seq: 0, cursor: { generation, nextSeq: 1 }, event: { type: "message.user", text: "one" } })
    expect(first.handle({ kind: "replay-end", cursor: { generation, nextSeq: 1 } }).kind).toBe("commit")
    const committed = { durable: first.durable, cursor: first.cursor! }
    expect(decodeSessionEventCursor(committed.cursor)).toEqual({ generation, nextSeq: 1 })

    const resumed = new SessionStreamMachine(committed)
    expect(resumed.requestCursor).toBe(committed.cursor)
    resumed.handle({ kind: "event", seq: 1, cursor: { generation, nextSeq: 2 }, event: { type: "message.user", text: "two" } })
    const commit = resumed.handle({ kind: "replay-end", cursor: { generation, nextSeq: 2 } })
    expect(commit.kind).toBe("commit")
    if (commit.kind === "commit") {
      expect(JSON.stringify(commit.state)).toContain("one")
      expect(JSON.stringify(commit.state)).toContain("two")
    }
  })

  test("an incomplete replay cannot mutate committed durable state", () => {
    const committed = new SessionStreamMachine()
    committed.handle({ kind: "replay-end", cursor: { generation: "g", nextSeq: 0 } })
    const attempt = new SessionStreamMachine({ durable: committed.durable, cursor: committed.cursor! })
    attempt.handle({ kind: "event", seq: 0, cursor: { generation: "g", nextSeq: 1 }, event: { type: "message.user", text: "uncommitted" } })
    expect(attempt.durable).toEqual(initialState)
    expect(attempt.cursor).toBe(committed.cursor)
  })

  test("live canonical deltas update only durable while other events remain visible", () => {
    const machine = new SessionStreamMachine()
    machine.handle({ kind: "replay-end", cursor: { generation: "g", nextSeq: 0 } })
    expect(machine.handle({ kind: "live", event: { type: "message.delta", text: "raw" } })).toMatchObject({ kind: "visible" })
    expect(machine.handle({ kind: "event", seq: 0, cursor: { generation: "g", nextSeq: 1 }, event: { type: "message.delta", text: "raw" } })).toMatchObject({ kind: "durable" })
    expect(machine.handle({ kind: "event", seq: 1, cursor: { generation: "g", nextSeq: 2 }, event: { type: "message.end" } })).toMatchObject({ kind: "visible" })
  })

  test("remote rewind preserves the committed display until rebuilt replay ends", () => {
    const oldGeneration = "before-rewind"
    const original = new SessionStreamMachine()
    original.handle({ kind: "event", seq: 0, cursor: { generation: oldGeneration, nextSeq: 1 }, event: { type: "message.user", text: "kept turn" } })
    original.handle({ kind: "event", seq: 1, cursor: { generation: oldGeneration, nextSeq: 2 }, event: { type: "message.user", text: "rewound turn" } })
    original.handle({ kind: "replay-end", cursor: { generation: oldGeneration, nextSeq: 2 } })
    const committed = { durable: original.durable, cursor: original.cursor! }

    // App's remote session.rewound path reattaches with preserveTranscript=true:
    // display remains this committed projection while the new machine replays.
    let visible = committed.durable
    const reattached = new SessionStreamMachine(committed)
    expect(reattached.requestCursor).toBe(committed.cursor)

    expect(reattached.handle({ kind: "replay-reset", reason: "history-rewritten", cursor: { generation: "after-rewind", nextSeq: 0 } })).toMatchObject({ kind: "reset" })
    expect(reattached.handle({ kind: "event", seq: 0, cursor: { generation: "after-rewind", nextSeq: 1 }, event: { type: "message.user", text: "kept turn" } })).toMatchObject({ kind: "replay-event" })
    // Replay-event steps update only the machine's working shadow; App does not
    // call setState until the following commit step.
    expect(JSON.stringify(visible)).toContain("rewound turn")
    expect(JSON.stringify(visible)).toContain("kept turn")

    const commit = reattached.handle({ kind: "replay-end", cursor: { generation: "after-rewind", nextSeq: 1 } })
    expect(commit.kind).toBe("commit")
    if (commit.kind === "commit") visible = commit.state
    expect(JSON.stringify(visible)).toContain("kept turn")
    expect(JSON.stringify(visible)).not.toContain("rewound turn")
  })

  test("reset rebuilds from scratch at replay-end", () => {
    const machine = new SessionStreamMachine()
    machine.handle({ kind: "event", seq: 0, cursor: { generation: "old", nextSeq: 1 }, event: { type: "message.user", text: "old" } })
    machine.handle({ kind: "replay-end", cursor: { generation: "old", nextSeq: 1 } })
    const rebuild = new SessionStreamMachine({ durable: machine.durable, cursor: machine.cursor! })
    rebuild.handle({ kind: "replay-reset", reason: "history-rewritten", cursor: { generation: "new", nextSeq: 0 } })
    rebuild.handle({ kind: "event", seq: 0, cursor: { generation: "new", nextSeq: 1 }, event: { type: "message.user", text: "new" } })
    const commit = rebuild.handle({ kind: "replay-end", cursor: { generation: "new", nextSeq: 1 } })
    expect(JSON.stringify(commit)).not.toContain("old")
    expect(JSON.stringify(commit)).toContain("new")
  })
})
