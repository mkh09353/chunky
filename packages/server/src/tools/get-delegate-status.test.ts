import { afterEach, describe, expect, test } from "bun:test"
import { createDetachedSpawn, finishDetachedSpawn, listDetachedSpawns, resetDetachedSpawns } from "../detached-spawns.ts"
import { getDelegateStatuses } from "./get-delegate-status.ts"

afterEach(async () => {
  for (const sessionId of ["status-list", "status-target", "status-unknown", "status-wait"]) {
    for (const record of listDetachedSpawns(sessionId)) if (record.status === "running") finishDetachedSpawn(record, "test cleanup")
  }
  await resetDetachedSpawns()
})

describe("get_delegate_status", () => {
  test("lists a running and a finished detached run", async () => {
    const running = createDetachedSpawn("status-list", "thread-running", "Running audit", true, { kind: "workflow" })!
    const finished = createDetachedSpawn("status-list", "thread-finished", "Finished child", true, { kind: "spawn_thread" })!
    finishDetachedSpawn(finished, "final report")

    const response = await getDelegateStatuses("status-list")
    expect("runs" in response && response.runs).toHaveLength(2)
    if (!("runs" in response)) throw new Error(response.error)
    expect(response.runs.find((run) => run.run_id === running.id)).toMatchObject({ kind: "workflow", status: "running", title: "Running audit" })
    expect(response.runs.find((run) => run.run_id === finished.id)).toMatchObject({ kind: "spawn_thread", status: "completed", result: "final report" })
  })

  test("targets one detached run by run_id", async () => {
    const alpha = createDetachedSpawn("status-target", "thread-alpha", "Alpha", true, { kind: "spawn_thread" })!
    createDetachedSpawn("status-target", "thread-beta", "Beta", true, { kind: "workflow" })
    const response = await getDelegateStatuses("status-target", { run_id: alpha.id })
    if (!("runs" in response)) throw new Error(response.error)
    expect(response.runs).toHaveLength(1)
    expect(response.runs[0]).toMatchObject({ run_id: alpha.id, title: "Alpha", status: "running" })
  })

  test("unknown run_id is explicit and points bash tasks elsewhere", async () => {
    const response = await getDelegateStatuses("status-unknown", { run_id: "missing" })
    expect(response).toEqual({
      error: "no delegate run with that id in this session (missing); bash background tasks use get_task_output.",
    })
  })

  test("positive timeout waits until the targeted run settles", async () => {
    const record = createDetachedSpawn("status-wait", "thread-wait", "Wait", true, { kind: "sidekick", seat: "frontend" })!
    setTimeout(() => finishDetachedSpawn(record, "settled report"), 30)
    const started = Date.now()
    const response = await getDelegateStatuses("status-wait", { run_id: record.id, timeout_ms: 1000 })
    expect(Date.now() - started).toBeGreaterThanOrEqual(20)
    if (!("runs" in response)) throw new Error(response.error)
    expect(response.runs[0]).toMatchObject({ run_id: record.id, status: "completed", result: "settled report" })
  })
})
