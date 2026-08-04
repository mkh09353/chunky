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

test("compaction artifacts round-trip and clear", () => {
  const id = `artifact-${crypto.randomUUID()}`
  Store.createSession(id)
  const artifact = { provider: "codex", model: "gpt-5.6-sol", replacementHistory: [{ type: "compaction", encrypted_content: "opaque" }], boundary: "summary" }
  Store.setCompactionArtifact(id, artifact)
  expect(Store.getCompactionArtifact(id)).toMatchObject(artifact)
  Store.clearCompactionArtifact(id)
  expect(Store.getCompactionArtifact(id)).toBeNull()
})

test("compaction artifacts invalidate on model changes, fork, and rewind", () => {
  const id = `artifact-invalidate-${crypto.randomUUID()}`
  Store.createSession(id)
  Store.pinSelection(id, { provider: "codex", model: "gpt-5.6-sol" } as any)
  Store.setCompactionArtifact(id, { provider: "codex", model: "gpt-5.6-sol", replacementHistory: [], boundary: "s" })
  Store.pinSelection(id, { provider: "codex", model: "gpt-5.6-sol" } as any)
  expect(Store.getCompactionArtifact(id)).not.toBeNull()
  Store.pinSelection(id, { provider: "openai", model: "gpt-5" } as any)
  expect(Store.getCompactionArtifact(id)).toBeNull()
  Store.setCompactionArtifact(id, { provider: "codex", model: "gpt-5.6-sol", replacementHistory: [], boundary: "s" })
  const child = `${id}-child`
  Store.forkSession(child, id, "/tmp", "normal")
  expect(Store.getCompactionArtifact(child)).toBeNull()
  const turn = Store.startTurn(id, "x", null)
  Store.rewindTranscript(id, turn, Store.turn(id, turn)!.startEventSeq)
  expect(Store.getCompactionArtifact(id)).toBeNull()
})

test("listShell aggregates workspaces as compact summaries sorted by activity", async () => {
  const older = `shell-old-${crypto.randomUUID()}`
  const newer = `shell-new-${crypto.randomUUID()}`
  Store.createSession(older, "Older", "/repo-one")
  // Ensure the activity timestamps differ without relying on timer resolution.
  await Bun.sleep(2)
  Store.createSession(newer, "Newer", "/repo-two")

  const sessions = Store.listShell().filter((session) => session.sessionId === older || session.sessionId === newer)
  expect(sessions).toEqual([
    expect.objectContaining({ sessionId: newer, title: "Newer", workspace: "/repo-two" }),
    expect.objectContaining({ sessionId: older, title: "Older", workspace: "/repo-one" }),
  ])
  for (const session of sessions) expect(Object.keys(session).sort()).toEqual([
    "createdAt", "incognito", "lastActivity", "sessionId", "title", "workspace",
  ])
})

test("recent history returns only the newest rows in chronological order", () => {
  const id = `recent-history-${crypto.randomUUID()}`
  Store.createSession(id)
  for (let i = 0; i < 5; i++) Store.appendEvent(id, { type: "message.delta", text: String(i) })

  expect(Store.recentHistoryWithSeq(id, 3)).toEqual([
    { seq: 2, event: { type: "message.delta", text: "2" } },
    { seq: 3, event: { type: "message.delta", text: "3" } },
    { seq: 4, event: { type: "message.delta", text: "4" } },
  ])
  expect(Store.recentHistoryWithSeq(id, 0)).toEqual([])
  expect(Store.recentHistoryWithSeq(id, -2)).toEqual([])
  expect(Store.recentHistoryWithSeq(id, 2.9)).toEqual([
    { seq: 3, event: { type: "message.delta", text: "3" } },
    { seq: 4, event: { type: "message.delta", text: "4" } },
  ])
})
