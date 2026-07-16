import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { bash } from "./bash.ts"
import { getTaskOutput, killTask } from "./task.ts"
import { resetTasks } from "../tasks.ts"

type Result = { promptText: string; raw?: { task_id?: string; results?: Array<Record<string, unknown>>; spill_path?: string } }
const config = (id: string) => ({ configurable: { thread_id: id } })
const launch = async (id: string, command: string): Promise<Result> => bash.invoke({ command, background: true }, config(id)) as Promise<Result>

afterEach(async () => { await resetTasks() })

describe("background task tools", () => {
  test("launches promptly and waits for sleep/echo", async () => {
    const id = "e2e-sleep"
    try {
      const started = Date.now()
      const launchResult = await launch(id, "sleep 0.15; echo finished")
      expect(Date.now() - started).toBeLessThan(100)
      const taskId = launchResult.raw?.task_id
      expect(taskId).toBe("task-1")
      const result = await getTaskOutput.invoke({ task_ids: [taskId!], timeout_ms: 2000 }, config(id)) as Result
      const item = result.raw?.results?.[0]
      expect(item?.status).toBe("completed")
      expect(item?.output).toContain("finished")
    } finally { await resetTasks() }
  })

  test("zero timeout snapshots running, positive timeout completes", async () => {
    const id = "e2e-poll"
    try {
      const launchResult = await launch(id, "sleep 0.2; echo polled")
      const taskId = launchResult.raw?.task_id
      const snapshot = await getTaskOutput.invoke({ task_ids: [taskId!], timeout_ms: 0 }, config(id)) as Result
      expect(snapshot.raw?.results?.[0]?.status).toBe("running")
      const waited = await getTaskOutput.invoke({ task_ids: [taskId!], timeout_ms: 2000 }, config(id)) as Result
      expect(waited.raw?.results?.[0]?.output).toContain("polled")
    } finally { await resetTasks() }
  })

  test("kill is terminal and idempotent", async () => {
    const id = "e2e-kill"
    try {
      const launchResult = await launch(id, "sleep 30")
      const taskId = launchResult.raw?.task_id
      const killed = await killTask.invoke({ task_id: taskId! }, config(id)) as Result
      expect(killed.raw).toMatchObject({ task_id: taskId, outcome: "killed" })
      const again = await killTask.invoke({ task_id: taskId! }, config(id)) as Result
      expect(again.raw).toMatchObject({ task_id: taskId, outcome: "already_exited" })
    } finally { await resetTasks() }
  })

  test("caps preview while spill retains full output", async () => {
    const id = "e2e-cap"
    try {
      const launchResult = await launch(id, "head -c 40000 /dev/zero | tr '\\0' x")
      const taskId = launchResult.raw?.task_id
      const result = await getTaskOutput.invoke({ task_ids: [taskId!], timeout_ms: 2000 }, config(id)) as Result
      const item = result.raw?.results?.[0]
      expect(item?.truncated).toBe(true)
      expect(Number(item?.raw_output_bytes)).toBe(40000)
      const spill = String(item?.spill_path)
      expect(existsSync(spill)).toBe(true)
      expect(readFileSync(spill).length).toBe(40000)
      expect(item?.reread_hint).toContain(`cat ${spill}`)
      expect(item?.reread_hint).not.toContain("Use read")
    } finally { await resetTasks() }
  })
})
