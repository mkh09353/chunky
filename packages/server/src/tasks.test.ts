import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { appendTaskOutput, cleanupSession, consumeTaskReminder, createTask, finishTask, pendingTaskReminders, resetTasks, snapshotTask, snapshotSessionTasks, taskOutputCap, taskSpillPath } from "./tasks.ts"

afterEach(async () => { await resetTasks() })

describe("background task registry", () => {
  test("numbers independently and tracks lifecycle timestamps", async () => {
    const a = Bun.spawn(["bash", "-lc", "printf a"], { stdout: "pipe", stderr: "pipe" })
    const b = Bun.spawn(["bash", "-lc", "printf b"], { stdout: "pipe", stderr: "pipe" })
    const ra = createTask("session-a", { command: "a", process: a, spillPath: taskSpillPath("session-a") })
    const rb = createTask("session-b", { command: "b", process: b, spillPath: taskSpillPath("session-b") })
    expect(ra.taskId).toBe("task-1"); expect(rb.taskId).toBe("task-1")
    appendTaskOutput(ra, "a"); finishTask(ra, 0); finishTask(rb, 1)
    expect(snapshotTask(ra).status).toBe("completed")
    expect(ra.endedAt).toBeGreaterThanOrEqual(ra.startedAt)
    expect(pendingTaskReminders("session-a")).toContain("task-1")
    expect(pendingTaskReminders("session-a")).toBe("")
  })

  test("caps preview by bytes and retains complete spill", () => {
    const proc = Bun.spawn(["bash", "-lc", "true"], { stdout: "pipe", stderr: "pipe" })
    const record = createTask("bytes", { command: "bytes", process: proc, spillPath: taskSpillPath("bytes") })
    const text = "é".repeat(taskOutputCap)
    appendTaskOutput(record, text); finishTask(record, 0)
    expect(record.rawOutputBytes).toBe(Buffer.byteLength(text))
    expect(record.truncated).toBe(true)
    expect(readFileSync(record.spillPath, "utf8")).toBe(text)
    expect(Buffer.byteLength(record.output)).toBeLessThanOrEqual(taskOutputCap)
  })

  test("consuming a polled completion prevents its reminder", () => {
    const proc = Bun.spawn(["bash", "-lc", "true"], { stdout: "pipe", stderr: "pipe" })
    const record = createTask("consume", { command: "true", process: proc, spillPath: taskSpillPath("consume") })
    finishTask(record, 0); consumeTaskReminder("consume", record.taskId)
    expect(pendingTaskReminders("consume")).toBe("")
  })
  test("snapshots live session tasks", () => {
    const proc = Bun.spawn(["bash", "-lc", "true"], { stdout: "pipe", stderr: "pipe" })
    const record = createTask("snap", { command: "true", process: proc, spillPath: taskSpillPath("snap") })
    expect(snapshotSessionTasks("snap")[0].taskId).toBe(record.taskId)
    finishTask(record, 0)
  })
})
