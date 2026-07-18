import { expect, test } from "bun:test"
import { Store } from "./store.ts"
import type { Goal } from "./goal.ts"

// Store is process-global in tests, so UUIDs make these durable rows isolated.
test("forkSession copies transcript, turns, selection, and metadata independently", () => {
  const parent = `fork-parent-${crypto.randomUUID()}`
  const child = `fork-child-${crypto.randomUUID()}`
  Store.createSession(parent, "Parent", "/parent-workspace")
  Store.pinSelection(parent, { provider: "openai", model: "gpt-test" } as any)
  Store.appendEvent(parent, { type: "message.user", text: "hello" })
  const turn = Store.startTurn(parent, "hello", "snapshot")
  Store.appendEvent(parent, { type: "message.delta", text: "answer" })
  Store.completeTurn(parent, turn, "checkpoint")
  Store.forkSession(child, parent, "/child-worktree", "worktree", "continue", { gitCommonDir: "/parent-workspace/.git", branch: "chunky/child" })
  expect(Store.history(child)).toEqual(Store.history(parent))
  expect(Store.turn(child, turn)).toEqual(Store.turn(parent, turn))
  expect(Store.pinnedSelectionOf(child)).toEqual(Store.pinnedSelectionOf(parent))
  expect(Store.forkBranchOf(child)).toEqual({ parentSessionId: parent, kind: "worktree", directive: "continue" })
  expect(Store.workspaceMetadataOf(child)).toEqual({ path: "/child-worktree", branch: "chunky/child", parentSessionId: parent })
  Store.appendEvent(child, { type: "message.user", text: "child only" })
  expect(Store.history(child)).toHaveLength(Store.history(parent).length + 1)
})

test("rewindTranscript removes events at its turn boundary and later turns while callers clear state", () => {
  const id = `rewind-${crypto.randomUUID()}`
  Store.createSession(id)
  Store.appendEvent(id, { type: "message.user", text: "one" })
  const first = Store.startTurn(id, "one", "a")
  Store.appendEvent(id, { type: "message.delta", text: "one" })
  Store.completeTurn(id, first, "a")
  Store.appendEvent(id, { type: "message.user", text: "two" })
  const second = Store.startTurn(id, "two", "b")
  Store.putTodos(id, [{ id: "todo", content: "remove", status: "pending" }])
  Store.putGoal({ sessionId: id, objective: "remove", status: "active", mode: "direct", createdAt: 1, updatedAt: 1, turns: 0, maxTurns: 2 } as Goal)
  const point = Store.turn(id, second)!
  Store.rewindTranscript(id, second, point.startEventSeq)
  Store.clearGoal(id); Store.clearTodos(id)
  // The visible user event is emitted before startTurn records its boundary;
  // rewind retains that transcript event and drops everything from the run.
  expect(Store.history(id).map((e) => e.type)).toEqual(["message.user", "message.delta", "message.user"])
  expect(Store.turn(id, second)).toBeNull()
  expect(Store.turn(id, first)).not.toBeNull()
  expect(Store.getGoal(id)).toBeNull()
  expect(Store.getTodos(id)).toEqual([])
})
