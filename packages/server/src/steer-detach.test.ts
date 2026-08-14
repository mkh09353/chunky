import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentEvent } from "@chunky/protocol"
import { installBackgroundDispatcher, resetBackgroundDispatcher } from "./background-dispatch.ts"
import { resetDetachedSpawns, runningDetachedSpawnSummaries } from "./detached-spawns.ts"
import type { AgentSelection } from "./providers/registry.ts"
import { ThreadManager } from "./threads.ts"
import { InterjectionBuffer, PromptQueue, formatInterjection } from "./prompt-queue.ts"
import { steerAtBoundary } from "./steer.ts"

const selection: AgentSelection = { provider: "zen", model: "test" }

afterEach(async () => { resetBackgroundDispatcher(); await resetDetachedSpawns() })

test("steer detaches an awaited delegate exactly once and routes its report through background dispatch", async () => {
  const wakes: string[] = []
  installBackgroundDispatcher({
    isRunning: () => false,
    wake: (_sessionId, prompt) => { wakes.push(prompt) },
    changed: () => {},
  })
  let finish!: (text: string) => void
  const work = new Promise<string>((resolve) => { finish = resolve })
  const manager = new ThreadManager((_: AgentEvent) => {}, "steer-detach", selection)
  const toolResult = manager.runSteerDetachable("sidekick", "Sidekick", work)
  const controller = new AbortController()
  const buffer = new InterjectionBuffer()
  expect(steerAtBoundary(buffer, { id: "steer", text: "change course" }, () => manager.detachForSteer())).toBe(true)
  expect(controller.signal.aborted).toBe(false)
  expect(buffer.drainAll()).toEqual([{ id: "steer", text: "change course" }])
  expect(manager.detachForSteer()).toBe(false)
  expect(await toolResult).toContain("detached by steer")
  expect(runningDetachedSpawnSummaries("steer-detach")).toHaveLength(1)
  finish("completed report")
  await Bun.sleep(0)
  expect(wakes).toHaveLength(1)
  expect(wakes[0]).toContain("completed report")
  manager.dispose()
})

test("explicit sidekick detach returns immediately, routes its report, and guards seats until settle", async () => {
  const wakes: string[] = []
  installBackgroundDispatcher({
    isRunning: () => false,
    wake: (_sessionId, prompt) => { wakes.push(prompt) },
    changed: () => {},
  })
  let finishFrontend!: (text: string) => void
  let frontendStarts = 0
  const frontendWork = () => {
    frontendStarts++
    return new Promise<string>((resolve) => { finishFrontend = resolve })
  }
  let finishBackend!: (text: string) => void
  const backendWork = () => new Promise<string>((resolve) => { finishBackend = resolve })
  const manager = new ThreadManager((_: AgentEvent) => {}, "explicit-sidekick-detach", selection)

  const first = await manager.runSteerDetachable("sidekick", "Sidekick (frontend)", frontendWork, { detach: true, seat: "frontend" })
  expect(first).toMatch(/detached;.*Run id: [0-9a-f-]+/i)
  expect(frontendStarts).toBe(1)
  expect(runningDetachedSpawnSummaries("explicit-sidekick-detach")).toHaveLength(1)

  const blocked = await manager.runSteerDetachable("sidekick", "Sidekick (frontend)", frontendWork, { detach: true, seat: "frontend" })
  expect(blocked).toBe('error: seat "frontend" has a detached brief in flight — wait for its report or route to another seat')
  expect(frontendStarts).toBe(1)

  const other = await manager.runSteerDetachable("sidekick", "Sidekick (backend)", backendWork, { detach: true, seat: "backend" })
  expect(other).toContain("detached;")
  finishBackend("backend report")
  finishFrontend("frontend report")
  await Bun.sleep(0)
  expect(wakes.some((wake) => wake.includes("frontend report"))).toBe(true)
  expect(wakes.some((wake) => wake.includes("backend report"))).toBe(true)

  let retryFinish!: (text: string) => void
  const retry = await manager.runSteerDetachable(
    "sidekick",
    "Sidekick (frontend)",
    () => new Promise<string>((resolve) => { retryFinish = resolve }),
    { detach: true, seat: "frontend" },
  )
  expect(retry).toContain("detached;")
  retryFinish("retry report")
  await Bun.sleep(0)
  manager.dispose()
})

test("detached sidekick default-seat guard clears after failure", async () => {
  const manager = new ThreadManager((_: AgentEvent) => {}, "default-seat-detach", selection)
  let fail!: (err: Error) => void
  const first = await manager.runSteerDetachable(
    "sidekick",
    "Sidekick",
    () => new Promise<string>((_resolve, reject) => { fail = reject }),
    { detach: true },
  )
  expect(first).toContain("detached;")
  expect(await manager.runSteerDetachable("sidekick", "Sidekick", () => Promise.resolve("unused"), { detach: true }))
    .toContain('seat "default" has a detached brief in flight')
  fail(new Error("worker failed"))
  await Bun.sleep(0)
  let finish!: (text: string) => void
  const retry = await manager.runSteerDetachable(
    "sidekick",
    "Sidekick",
    () => new Promise<string>((resolve) => { finish = resolve }),
    { detach: true },
  )
  expect(retry).toContain("detached;")
  finish("recovered")
  await Bun.sleep(0)
  manager.dispose()
})

test("omitting explicit detach still waits synchronously", async () => {
  const manager = new ThreadManager((_: AgentEvent) => {}, "synchronous-sidekick", selection)
  let finish!: (text: string) => void
  let settled = false
  const result = manager.runSteerDetachable(
    "sidekick",
    "Sidekick",
    () => new Promise<string>((resolve) => { finish = resolve }),
  ).then((text) => { settled = true; return text })
  await Bun.sleep(0)
  expect(settled).toBe(false)
  finish("synchronous report")
  expect(await result).toBe("synchronous report")
  expect(runningDetachedSpawnSummaries("synchronous-sidekick")).toHaveLength(0)
  manager.dispose()
})

test("steer without an awaited delegate buffers until a boundary without detaching or aborting", () => {
  const controller = new AbortController()
  const buffer = new InterjectionBuffer()
  let detachCalls = 0
  expect(steerAtBoundary(buffer, { id: "steer", text: "new direction" }, () => { detachCalls++; return false })).toBe(false)
  expect(detachCalls).toBe(1)
  expect(controller.signal.aborted).toBe(false)
  expect(buffer.drainAll()).toEqual([{ id: "steer", text: "new direction" }])
})

test("an unconsumed steer uses the existing leftover interjection queue shape", () => {
  const buffer = new InterjectionBuffer()
  steerAtBoundary(buffer, { id: "steer", text: "follow up" }, () => false)
  const queue = new PromptQueue()
  for (const note of buffer.drainAll()) queue.enqueue({ prompt: formatInterjection(note.text), shown: note.text, images: note.images, kind: "interject" })
  expect(queue.shift()).toMatchObject({ shown: "follow up", prompt: expect.stringContaining("follow up"), kind: "interject" })
})

test("explicit workflow detach returns immediately and wakes with the final result only", async () => {
  const wakes: Array<{ prompt: string; shown: string; from?: string; provenance?: { kind: string; detachedSpawnId: string } }> = []
  installBackgroundDispatcher({
    isRunning: () => false,
    wake: (_id, prompt, shown, from, provenance) => wakes.push({ prompt, shown, from, provenance }),
    changed: () => {},
  })
  let finish!: (text: string) => void
  let started = false
  const manager = new ThreadManager((_: AgentEvent) => {}, "detached-workflow", selection)
  const result = await manager.runSteerDetachable(
    "workflow",
    "Workflow",
    () => {
      started = true
      return new Promise<string>((resolve) => { finish = resolve })
    },
    { detach: true },
  )
  expect(result).toMatch(/detached;.*Run id: [0-9a-f-]+/i)
  expect(result).not.toContain("final synthesis")
  expect(started).toBe(true)
  expect(runningDetachedSpawnSummaries("detached-workflow")).toHaveLength(1)
  expect(wakes).toHaveLength(0)
  finish("final synthesis")
  await Bun.sleep(0)
  expect(wakes).toHaveLength(1)
  expect(wakes[0]!.prompt).toContain("final synthesis")
  expect(wakes[0]!.prompt).not.toContain("child transcript")
  expect(wakes[0]!.from).toBe("workflow")
  expect(wakes[0]!.provenance?.kind).toBe("workflow")
  expect(wakes[0]!.provenance?.detachedSpawnId).toMatch(/^[0-9a-f-]+$/)
  manager.dispose()
})

test("detached workflow error is delivered as a wake with the error string", async () => {
  const wakes: string[] = []
  installBackgroundDispatcher({
    isRunning: () => false,
    wake: (_id, prompt) => { wakes.push(prompt) },
    changed: () => {},
  })
  let fail!: (err: Error) => void
  const manager = new ThreadManager((_: AgentEvent) => {}, "detached-workflow-throw", selection)
  const result = await manager.runSteerDetachable(
    "workflow",
    "Workflow",
    () => new Promise<string>((_resolve, reject) => { fail = reject }),
    { detach: true },
  )
  expect(result).toContain("detached;")
  fail(new Error("script exploded"))
  await Bun.sleep(0)
  expect(wakes).toHaveLength(1)
  expect(wakes[0]).toContain("failed")
  expect(wakes[0]).toContain("error: script exploded")
  manager.dispose()
})

test("detached workflow error wake mentions resume_from_run_id", async () => {
  const home = mkdtempSync(join(tmpdir(), "chunky-workflow-resume-hint-"))
  const prev = {
    CHUNKY_HOME: process.env.CHUNKY_HOME,
    CHUNKY_SETTINGS: process.env.CHUNKY_SETTINGS,
    CHUNKY_DB: process.env.CHUNKY_DB,
  }
  process.env.CHUNKY_HOME = home
  delete process.env.CHUNKY_SETTINGS
  delete process.env.CHUNKY_DB
  try {
    const wakes: string[] = []
    installBackgroundDispatcher({
      isRunning: () => false,
      wake: (_id, prompt) => { wakes.push(prompt) },
      changed: () => {},
    })
    const manager = new ThreadManager((_: AgentEvent) => {}, "detached-workflow-resume-hint", selection)
    const result = await manager.runSteerDetachable(
      "workflow",
      "Workflow",
      () => manager.runWorkflow({
        callerThreadId: "detached-workflow-resume-hint",
        script: "throw new Error('script exploded')",
      }),
      { detach: true },
    )
    expect(result).toContain("detached;")
    for (let i = 0; i < 40 && wakes.length === 0; i++) await Bun.sleep(5)
    expect(wakes).toHaveLength(1)
    expect(wakes[0]).toContain("workflow error:")
    expect(wakes[0]).toContain("resume_from_run_id")
    expect(wakes[0]).toMatch(/Run id: [0-9a-f-]+/)
    manager.dispose()
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(home, { recursive: true, force: true })
  }
})

test("detached workflow script error string is delivered as a completed wake", async () => {
  const wakes: string[] = []
  installBackgroundDispatcher({
    isRunning: () => false,
    wake: (_id, prompt) => { wakes.push(prompt) },
    changed: () => {},
  })
  let finish!: (text: string) => void
  const manager = new ThreadManager((_: AgentEvent) => {}, "detached-workflow-error", selection)
  await manager.runSteerDetachable(
    "workflow",
    "Workflow",
    () => new Promise<string>((resolve) => { finish = resolve }),
    { detach: true },
  )
  finish("workflow error: Date.now() is disabled")
  await Bun.sleep(0)
  expect(wakes).toHaveLength(1)
  expect(wakes[0]).toContain("finished")
  expect(wakes[0]).toContain("workflow error: Date.now() is disabled")
  manager.dispose()
})

test("omitting workflow detach still waits synchronously and allows STEER-detach", async () => {
  const manager = new ThreadManager((_: AgentEvent) => {}, "sync-workflow", selection)
  let finish!: (text: string) => void
  let settled = false
  const result = manager.runSteerDetachable(
    "workflow",
    "Workflow",
    () => new Promise<string>((resolve) => { finish = resolve }),
  ).then((text) => { settled = true; return text })
  await Bun.sleep(0)
  expect(settled).toBe(false)
  expect(manager.detachForSteer()).toBe(true)
  expect(await result).toContain("detached by steer")
  expect(runningDetachedSpawnSummaries("sync-workflow")).toHaveLength(1)
  finish("late report")
  await Bun.sleep(0)
  manager.dispose()
})

test("explicit workflow detach skips the STEER race", async () => {
  const manager = new ThreadManager((_: AgentEvent) => {}, "explicit-workflow-steer", selection)
  let finish!: (text: string) => void
  const result = await manager.runSteerDetachable(
    "workflow",
    "Workflow",
    () => new Promise<string>((resolve) => { finish = resolve }),
    { detach: true },
  )
  expect(result).toContain("detached;")
  expect(result).not.toContain("detached by steer")
  expect(manager.detachForSteer()).toBe(false)
  finish("done")
  await Bun.sleep(0)
  manager.dispose()
})

test("detached workflow children survive the originating turn abort", async () => {
  const turnAbort = new AbortController()
  let childSignal: AbortSignal | undefined
  let releaseStream!: () => void
  const hold = new Promise<void>((resolve) => { releaseStream = resolve })
  const manager = new ThreadManager((_: AgentEvent) => {}, "detached-workflow-live", selection, () => ({
    async stream(_input: unknown, config: any) {
      childSignal = config.signal
      await hold
      return (async function* () {
        yield ["messages", [{ type: "ai", content: "still running", response_metadata: { finish_reason: "stop" } }, {}]]
      })()
    },
  }), undefined, undefined, turnAbort)
  const detached = await manager.runSteerDetachable(
    "workflow",
    "Workflow",
    () => manager.runWorkflow({ callerThreadId: "detached-workflow-live", script: "return await agent('keep going')" }),
    { detach: true },
  )
  expect(detached).toContain("detached;")
  while (!childSignal) await Bun.sleep(0)
  turnAbort.abort("turn ended")
  await Bun.sleep(5)
  expect(childSignal.aborted).toBe(false)
  releaseStream()
  await Bun.sleep(0)
  manager.dispose()
})

test("hard stop still aborts delegate watchdogs", async () => {
  const abort = new AbortController()
  let childSignal: AbortSignal | undefined
  const agent = () => ({
    async stream(_input: unknown, config: any) {
      childSignal = config.signal
      return (async function* () { while (!config.signal.aborted) await Bun.sleep(1); throw new DOMException("aborted", "AbortError") })()
    },
  })
  const manager = new ThreadManager((_: AgentEvent) => {}, "hard-stop", selection, agent, undefined, undefined, abort)
  const work = manager.spawn({ callerThreadId: "hard-stop", title: "child", instructions: "work" })
  while (!childSignal) await Bun.sleep(0)
  abort.abort("stop")
  await work
  expect(childSignal!.aborted).toBe(true)
  manager.dispose()
})
