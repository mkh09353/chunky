import { afterEach, describe, expect, test } from "bun:test"
import { ThreadManager, type AgentForSelection } from "./threads.ts"
import { runSpawnThread } from "./tools/spawn-thread.ts"
import { peekTaskReminders, resetTasks } from "./tasks.ts"
import { installBackgroundDispatcher, resetBackgroundDispatcher } from "./background-dispatch.ts"
import { createDetachedSpawn, detachedSpawnResultCap, finishDetachedSpawn, resetDetachedSpawns, sweepDetachedSpawnsForTests } from "./detached-spawns.ts"

const selection = { provider: "zen", model: "test-model" }

function gatedAgent(gate: Promise<void>): AgentForSelection {
  return () => ({ stream: async () => {
    await gate
    return (async function* () {
      yield ["messages", [{ type: "ai", content: "detached report", response_metadata: { finish_reason: "stop" } }, {}]]
    })()
  } })
}

async function eventually(check: () => boolean): Promise<void> {
  for (let i = 0; i < 40 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 5))
  expect(check()).toBe(true)
}

afterEach(async () => {
  await resetDetachedSpawns()
  await resetTasks()
  resetBackgroundDispatcher()
})

describe("detached spawn_thread", () => {
  test("caps finished reports and evicts them after the terminal TTL", () => {
    const record = createDetachedSpawn("evict", "child", "Child")!
    finishDetachedSpawn(record, "x".repeat(detachedSpawnResultCap + 100))
    expect(record.result!.length).toBeLessThanOrEqual(detachedSpawnResultCap)
    sweepDetachedSpawnsForTests(record.endedAt! + 30 * 60_000)
    const replacement = createDetachedSpawn("evict", "child-2", "Child 2")!
    expect(replacement).toBeDefined()
    finishDetachedSpawn(replacement, "done")
  })
  test("returns immediately and wakes an idle lead with its report", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const wakes: Array<{ prompt: string; shown: string; from?: string; provenance?: { kind: string; detachedSpawnId: string } }> = []
    installBackgroundDispatcher({ isRunning: () => false, wake: (_id, prompt, shown, from, provenance) => wakes.push({ prompt, shown, from, provenance }), changed: () => {} })
    const manager = new ThreadManager(() => {}, "detached-idle", selection, gatedAgent(gate), undefined, "/tmp")
    const result = manager.launchDetachedSpawn({ callerThreadId: "detached-idle", title: "Inspect", instructions: "inspect it" })
    expect(result).toMatch(/^Detached child "Inspect" launched: /)
    expect(wakes).toHaveLength(0)
    release()
    await eventually(() => wakes.length === 1)
    const detachedSpawnId = result.match(/launched: ([0-9a-f-]+)/i)?.[1]
    expect(wakes[0]).toMatchObject({ shown: expect.stringContaining('Detached child "Inspect"'), from: "spawn_thread",
      provenance: { kind: "spawn_thread", detachedSpawnId } })
    expect(wakes[0]!.prompt).toContain("detached report")
    manager.dispose()
  })

  test("queues the full report as a reminder while the lead is busy", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    installBackgroundDispatcher({ isRunning: () => true, wake: () => { throw new Error("busy session must not wake") }, changed: () => {} })
    const manager = new ThreadManager(() => {}, "detached-busy", selection, gatedAgent(gate), undefined, "/tmp")
    manager.launchDetachedSpawn({ callerThreadId: "detached-busy", title: "Inspect", instructions: "inspect it" })
    release()
    await eventually(() => peekTaskReminders("detached-busy").text.includes("detached report"))
    manager.dispose()
  })

  test("enforces eight concurrent detached children per session", () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const manager = new ThreadManager(() => {}, "detached-cap", selection, gatedAgent(gate), undefined, "/tmp")
    for (let i = 0; i < 8; i++) expect(manager.launchDetachedSpawn({ callerThreadId: "detached-cap", title: `Child ${i}`, instructions: "wait" })).toContain("launched:")
    expect(manager.launchDetachedSpawn({ callerThreadId: "detached-cap", title: "Too many", instructions: "wait" })).toContain("error: detached spawn limit reached (8 running children")
    release()
    manager.dispose()
  })

  test("keeps non-detached spawn synchronous and returns its final answer", async () => {
    const immediate: AgentForSelection = () => ({ stream: async () => (async function* () {
      yield ["messages", [{ type: "ai", content: "synchronous report", response_metadata: { finish_reason: "stop" } }, {}]]
    })() })
    const manager = new ThreadManager(() => {}, "sync-spawn", selection, immediate, undefined, "/tmp")
    const result = await runSpawnThread({ title: "Sync", instructions: "answer" }, "sync-spawn")
    expect(result).toContain('Child thread "Sync" finished.')
    expect(result).toContain("synchronous report")
    manager.dispose()
  })
})
