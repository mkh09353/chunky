import { describe, expect, test } from "bun:test"
import { formatSystemReminder } from "./system-reminder.ts"

describe("system reminder formatter", () => {
  test("empty is null", () => expect(formatSystemReminder({})).toBeNull())
  test("goal only", () => expect(formatSystemReminder({ goal: { objective: "Ship it", status: "active", mode: "direct", turns: 1, maxTurns: 3 } })).toContain("Ship it"))
  test("tasks only", () => expect(formatSystemReminder({ tasks: [{ taskId: "task-1", status: "running", command: "bun test" }] })).toContain("bun test"))
  test("sidekick and child state", () => expect(formatSystemReminder({ sidekicks: [{ seat: "review", brief: "check" }], children: [{ threadId: "child", title: "build" }] })).toContain("child"))
  test("escapes, normalizes, and bounds output", () => {
    const result = formatSystemReminder({ goal: { objective: "<x>\n  &", status: "a", mode: "b", turns: 1, maxTurns: 2 }, tasks: Array.from({ length: 100 }, (_, i) => ({ taskId: `${i}`, status: "running", command: "x" })) })!
    expect(result).toContain("&lt;x&gt; &amp;")
    expect(result.split("\n").length).toBeLessThanOrEqual(40)
  })
})

test("notes bypass the 38-line state cap", () => {
  const noteText = Array.from({ length: 60 }, (_, i) => `note line ${i}`).join("\n")
  const result = formatSystemReminder({
    tasks: Array.from({ length: 100 }, (_, i) => ({ taskId: `${i}`, status: "running", command: "state" })),
    notes: [{ path: "notes.md", lines: 60, bytes: Buffer.byteLength(noteText), text: noteText }],
  })!
  expect(result).toContain("note line 59")
  expect(result).toContain("## Session Notes (persist across compaction; maintain with the notes tool)")
})

test("notes inline whole files within 24k and index remaining files", () => {
  const inline = "a".repeat(23_990)
  const indexed = "secret-index-only"
  const result = formatSystemReminder({ notes: [
    { path: "recent.md", lines: 1, bytes: inline.length, text: inline },
    { path: "older.md", lines: 1, bytes: indexed.length, text: indexed },
  ] })!
  expect(result).toContain(inline)
  expect(result).not.toContain(indexed)
  expect(result).toContain("- older.md (1 lines, 17 bytes) — notes action=read")
})
