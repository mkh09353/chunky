import { expect, test } from "bun:test"
import { Store } from "./store.ts"

// Store is process-global in tests, so UUIDs keep these rows isolated.
test("copyNotes remaps the lead thread id and preserves other thread ids", () => {
  const from = `notes-from-${crypto.randomUUID()}`
  const to = `notes-to-${crypto.randomUUID()}`
  Store.createSession(from, "From")
  Store.createSession(to, "To")
  Store.putNote(from, from, "notes.md", "lead checkpoint")
  Store.putNote(from, `${from}:sidekick`, "notes.md", "sidekick checkpoint")
  Store.putNote(to, to, "existing.md", "already here")

  expect(Store.copyNotes(from, to, { fromThreadId: from, toThreadId: to })).toBe(2)
  expect(Store.getNote(to, to, "notes.md")).toBe("lead checkpoint")
  expect(Store.getNote(to, `${from}:sidekick`, "notes.md")).toBe("sidekick checkpoint")
  expect(Store.getNote(to, to, "existing.md")).toBe("already here")
  // Source is untouched.
  expect(Store.listNotes(from).map((n) => n.threadId).sort()).toEqual([from, `${from}:sidekick`].sort())
})

test("copyNotes can restrict to one source thread and reports zero when nothing matches", () => {
  const from = `notes-only-from-${crypto.randomUUID()}`
  const to = `notes-only-to-${crypto.randomUUID()}`
  Store.createSession(from, "From")
  Store.createSession(to, "To")
  Store.putNote(from, from, "notes.md", "lead")
  Store.putNote(from, `${from}:sidekick`, "notes.md", "worker")
  expect(Store.copyNotes(from, to, { fromThreadId: from, toThreadId: to }, from)).toBe(1)
  expect(Store.listNotes(to)).toHaveLength(1)
  expect(Store.getNote(to, to, "notes.md")).toBe("lead")
  const empty = `notes-empty-${crypto.randomUUID()}`
  Store.createSession(empty, "Empty")
  expect(Store.copyNotes(empty, to, { fromThreadId: empty, toThreadId: to })).toBe(0)
})

test("forkSession carries notes into the child with the lead thread remapped", () => {
  const parent = `fork-notes-parent-${crypto.randomUUID()}`
  const child = `fork-notes-child-${crypto.randomUUID()}`
  Store.createSession(parent, "Parent", "/parent-workspace")
  Store.putNote(parent, parent, "notes.md", "parent lead notes")
  Store.putNote(parent, `${parent}:sidekick:frontend`, "plan.md", "seat notes")
  Store.forkSession(child, parent, "/parent-workspace", "normal")
  expect(Store.getNote(child, child, "notes.md")).toBe("parent lead notes")
  expect(Store.getNote(child, `${parent}:sidekick:frontend`, "plan.md")).toBe("seat notes")
  expect(Store.getNote(child, parent, "notes.md")).toBeNull()
  // Divergence after the fork stays independent.
  Store.putNote(child, child, "notes.md", "child edits")
  expect(Store.getNote(parent, parent, "notes.md")).toBe("parent lead notes")
})
