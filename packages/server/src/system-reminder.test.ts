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
