import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentEvent } from "@chunky/protocol"
import { createIsolatedTestState, removeIsolatedTestState } from "./test-state.ts"

const PREFIX = "chunky-stop-delegate-"
const state = createIsolatedTestState(PREFIX)
process.env.CHUNKY_SETTINGS = state.settings
process.env.CHUNKY_DB = state.db
process.env.CHUNKY_HOME = state.root
process.env.CHUNKY_MODELS_CACHE = join(state.root, "missing-models.json")

const { resetBackgroundDispatcher } = await import("./background-dispatch.ts")
const { getDetachedSpawn, resetDetachedSpawns } = await import("./detached-spawns.ts")
const { executorToolsFor } = await import("./agent.ts")
const { evalCandidateDir } = await import("./eval-recorder.ts")
const { setSidekick, setSidekickSeat, setEvalsMode } = await import("./settings.ts")
const { Store } = await import("./store.ts")
const {
  activeSidekickSummaries,
  resetLiveDelegatesForTests,
  stopDelegate,
  ThreadManager,
} = await import("./threads.ts")
type AgentForSelection = import("./threads.ts").AgentForSelection
const { runStopDelegate, stopDelegateTool } = await import("./tools/stop-delegate.ts")
const { rateDelegate } = await import("./tools/rate-delegate.ts")
const { registerThread, unregisterThread } = await import("./thread-context.ts")

afterAll(() => removeIsolatedTestState(state.root, PREFIX))

const selection = { provider: "zen", model: "test-model" }

function hangingAgent(): AgentForSelection {
  return () => ({
    async stream(_input: unknown, config: any) {
      return (async function* () {
        while (!config.signal.aborted) await Bun.sleep(1)
        throw new DOMException("The operation was aborted.", "AbortError")
      })()
    },
  })
}

function checkpointAgent(): AgentForSelection {
  const history = new Map<string, string[]>()
  return () => ({
    async stream(input: unknown, config: any) {
      const threadId = config.configurable.thread_id as string
      const prior = history.get(threadId) ?? []
      const content = String((input as { messages?: Array<{ content?: unknown }> }).messages?.[0]?.content ?? "")
      if (config.signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError")
      if (content.includes("continue on the same seat")) {
        return (async function* () {
          yield ["messages", [{ type: "ai", content: `resumed:${prior.length}:${prior.at(-1) ?? ""}`, response_metadata: { finish_reason: "stop" } }, {}]]
        })()
      }
      prior.push(content)
      history.set(threadId, prior)
      return (async function* () {
        while (!config.signal.aborted) await Bun.sleep(1)
        throw new DOMException("The operation was aborted.", "AbortError")
      })()
    },
  })
}

async function eventually(check: () => boolean, attempts = 80): Promise<void> {
  for (let i = 0; i < attempts && !check(); i++) await Bun.sleep(5)
  expect(check()).toBe(true)
}

afterEach(async () => {
  await resetDetachedSpawns()
  resetLiveDelegatesForTests()
  resetBackgroundDispatcher()
})

describe("stop_delegate", () => {
  test("cancels a detached spawn mid-flight as cancelled, not failed", async () => {
    let childSignal: AbortSignal | undefined
    const agent: AgentForSelection = () => ({
      async stream(_input: unknown, config: any) {
        childSignal = config.signal
        return (async function* () {
          while (!config.signal.aborted) await Bun.sleep(1)
          throw new DOMException("The operation was aborted.", "AbortError")
        })()
      },
    })
    const events: AgentEvent[] = []
    const manager = new ThreadManager((ev) => { events.push(ev) }, "stop-detached", selection, agent, undefined, "/tmp")
    const launched = manager.launchDetachedSpawn({
      callerThreadId: "stop-detached",
      title: "Inspect",
      instructions: "inspect it",
    })
    expect(launched).toMatch(/^Detached child "Inspect" launched: /)
    const runId = launched.match(/launched: ([0-9a-f-]+)/i)![1]!
    await eventually(() => childSignal !== undefined)
    const started = Date.now()
    const result = await stopDelegate("stop-detached", { runId }, "user")
    expect(Date.now() - started).toBeLessThan(250)
    expect(result.outcome).toBe("cancelled")
    expect(result.status).toBe("cancelled")
    expect(result.runId).toBe(runId)
    expect(childSignal!.aborted).toBe(true)
    await eventually(() => getDetachedSpawn("stop-detached", runId)?.status === "cancelled")
    const record = getDetachedSpawn("stop-detached", runId)!
    expect(record.status).toBe("cancelled")
    expect(record.result).toMatch(/cancelled by user/i)
    expect(events.some((ev) => ev.type === "thread.status" && ev.threadId === record.childThreadId && ev.status === "cancelled")).toBe(true)
    expect(events.some((ev) => ev.type === "error")).toBe(false)
    await eventually(() => Store.delegationsForSession("stop-detached").some((row) => row.cancelled === 1))
    const rows = Store.delegationsForSession("stop-detached")
    expect(rows).toHaveLength(1)
    expect(rows[0]!.cancelled).toBe(1)
    expect(rows[0]!.ok).toBeNull()
    expect(rows[0]!.completed_at).toBeNumber()
    expect(Store.resolveDelegation("stop-detached", "last")).toBeNull()
    expect(Store.scoreboardRows("stop-detached")).toEqual([])
    const replayed = await stopDelegate("stop-detached", { runId }, "user")
    expect(replayed.outcome).toBe("already-finished")
    expect(replayed.status).toBe("cancelled")
    manager.dispose()
  })

  test("cancels a synchronous sidekick without aborting the lead turn and reuses the seat identity", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chunky-stop-sidekick-"))
    const previous = process.env.CHUNKY_SETTINGS
    process.env.CHUNKY_SETTINGS = join(dir, "settings.json")
    setSidekick({ enabled: true })
    setEvalsMode("record")
    Store.createSession("stop-sync-sidekick", "Stop sync", "/tmp")
    const leadAbort = new AbortController()
    let capturedThreadId: string | undefined
    let starts = 0
    const sidekickAgent = checkpointAgent()
    const wrapped: AgentForSelection = (sel, ws, md, session, mem) => {
      const inner = sidekickAgent(sel, ws, md, session, mem)
      return {
        async stream(input: unknown, config: any) {
          starts += 1
          capturedThreadId = config.configurable.thread_id as string
          return inner.stream(input, config)
        },
      }
    }
    const events: AgentEvent[] = []
    const manager = new ThreadManager(
      (ev) => { events.push(ev) },
      "stop-sync-sidekick",
      selection,
      hangingAgent(),
      undefined,
      "/tmp",
      leadAbort,
      wrapped,
    )
    const work = manager.delegateToSidekick({ callerThreadId: "stop-sync-sidekick", brief: "do the work" })
    await eventually(() => capturedThreadId === "stop-sync-sidekick:sidekick")
    await eventually(() => activeSidekickSummaries("stop-sync-sidekick").length === 1)
    const started = Date.now()
    const stopped = await stopDelegate("stop-sync-sidekick", {}, "user")
    expect(Date.now() - started).toBeLessThan(250)
    expect(stopped.outcome).toBe("cancelled")
    expect(stopped.threadId).toBe("stop-sync-sidekick:sidekick")
    const report = await work
    expect(report).toBe("cancelled by user")
    expect(leadAbort.signal.aborted).toBe(false)
    expect(activeSidekickSummaries("stop-sync-sidekick")).toHaveLength(0)
    expect(events.some((ev) => ev.type === "thread.status" && ev.threadId === "stop-sync-sidekick:sidekick" && ev.status === "cancelled")).toBe(true)
    expect(events.some((ev) => ev.type === "error")).toBe(false)
    const rows = Store.delegationsForSession("stop-sync-sidekick")
    expect(rows.some((row) => row.kind === "sidekick" && row.cancelled === 1 && row.ok == null && row.completed_at != null)).toBe(true)
    const cancelledId = rows.find((row) => row.cancelled === 1)!.id
    expect(existsSync(join(evalCandidateDir(cancelledId), "candidate.json"))).toBe(false)
    expect(Store.resolveDelegation("stop-sync-sidekick", "last")).toBeNull()

    const again = await stopDelegate("stop-sync-sidekick", {}, "user")
    expect(again.outcome).toBe("already-finished")
    expect(again.status).toBe("cancelled")

    const follow = await manager.delegateToSidekick({ callerThreadId: "stop-sync-sidekick", brief: "continue on the same seat" })
    expect(follow).toContain("resumed:")
    expect(follow).toContain("do the work")
    expect(starts).toBeGreaterThanOrEqual(2)
    manager.dispose()
    if (previous == null) delete process.env.CHUNKY_SETTINGS
    else process.env.CHUNKY_SETTINGS = previous
    rmSync(dir, { recursive: true, force: true })
  })

  test("named seat cancel does not stop the default seat", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chunky-stop-named-"))
    const previous = process.env.CHUNKY_SETTINGS
    process.env.CHUNKY_SETTINGS = join(dir, "settings.json")
    setSidekick({ enabled: true })
    setSidekickSeat("frontend", { provider: "zen", model: "test-model", effort: "high" })
    const leadAbort = new AbortController()
    const signals = new Map<string, AbortSignal>()
    const seatAgent: AgentForSelection = () => ({
      async stream(_input: unknown, config: any) {
        const threadId = config.configurable.thread_id as string
        signals.set(threadId, config.signal)
        return (async function* () {
          while (!config.signal.aborted) await Bun.sleep(1)
          throw new DOMException("The operation was aborted.", "AbortError")
        })()
      },
    })
    const manager = new ThreadManager(
      () => undefined,
      "stop-named",
      selection,
      hangingAgent(),
      undefined,
      "/tmp",
      leadAbort,
      seatAgent,
    )
    const named = manager.delegateToSidekick({ callerThreadId: "stop-named", brief: "style it", seat: "frontend" })
    const def = manager.delegateToSidekick({ callerThreadId: "stop-named", brief: "default work" })
    await eventually(() => signals.has("stop-named:sidekick:frontend") && signals.has("stop-named:sidekick"))
    expect((await stopDelegate("stop-named", {}, "user")).threadId).toBe("stop-named:sidekick")
    expect(await def).toBe("cancelled by user")
    expect(signals.get("stop-named:sidekick:frontend")!.aborted).toBe(false)
    expect(leadAbort.signal.aborted).toBe(false)
    expect((await stopDelegate("stop-named", { seat: "frontend" }, "user")).threadId).toBe("stop-named:sidekick:frontend")
    expect(await named).toBe("cancelled by user")
    manager.dispose()
    if (previous == null) delete process.env.CHUNKY_SETTINGS
    else process.env.CHUNKY_SETTINGS = previous
    rmSync(dir, { recursive: true, force: true })
  })

  test("runId cancel reaches a detach=true sidekick watchdog without aborting the lead", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chunky-stop-detach-"))
    const previous = process.env.CHUNKY_SETTINGS
    process.env.CHUNKY_SETTINGS = join(dir, "settings.json")
    setSidekick({ enabled: true })
    const leadAbort = new AbortController()
    let childSignal: AbortSignal | undefined
    const agent: AgentForSelection = () => ({
      async stream(_input: unknown, config: any) {
        childSignal = config.signal
        return (async function* () {
          while (!config.signal.aborted) await Bun.sleep(1)
          throw new DOMException("The operation was aborted.", "AbortError")
        })()
      },
    })
    const events: AgentEvent[] = []
    const manager = new ThreadManager(
      (ev) => { events.push(ev) },
      "stop-detach-sidekick",
      selection,
      hangingAgent(),
      undefined,
      "/tmp",
      leadAbort,
      agent,
    )
    const launched = await manager.runSteerDetachable(
      "sidekick",
      "Sidekick",
      () => manager.delegateToSidekick({ callerThreadId: "stop-detach-sidekick", brief: "background it" }),
      { detach: true, seat: "default" },
    )
    expect(launched).toMatch(/Run id: /)
    const runId = launched.match(/Run id: ([0-9a-f-]+)/i)![1]!
    await eventually(() => childSignal !== undefined)
    const started = Date.now()
    const result = await stopDelegate("stop-detach-sidekick", { runId }, "user")
    expect(Date.now() - started).toBeLessThan(250)
    expect(result.outcome).toBe("cancelled")
    expect(childSignal!.aborted).toBe(true)
    expect(leadAbort.signal.aborted).toBe(false)
    await eventually(() => getDetachedSpawn("stop-detach-sidekick", runId)?.status === "cancelled")
    expect(events.some((ev) => ev.type === "error")).toBe(false)
    expect(events.some((ev) => ev.type === "thread.status" && ev.status === "cancelled")).toBe(true)
    const replayed = await stopDelegate("stop-detach-sidekick", { runId }, "user")
    expect(replayed.outcome).toBe("already-finished")
    manager.dispose()
    if (previous == null) delete process.env.CHUNKY_SETTINGS
    else process.env.CHUNKY_SETTINGS = previous
    rmSync(dir, { recursive: true, force: true })
  })

  test("runId stop of one detached child does not abort a sibling live delegate or the lead", async () => {
    const leadAbort = new AbortController()
    const signals = new Map<string, AbortSignal>()
    const agent: AgentForSelection = () => ({
      async stream(_input: unknown, config: any) {
        signals.set(config.configurable.thread_id as string, config.signal)
        return (async function* () {
          while (!config.signal.aborted) await Bun.sleep(1)
          throw new DOMException("The operation was aborted.", "AbortError")
        })()
      },
    })
    const manager = new ThreadManager(
      () => undefined,
      "stop-sibling",
      selection,
      agent,
      undefined,
      "/tmp",
      leadAbort,
    )
    const launched = manager.launchDetachedSpawn({
      callerThreadId: "stop-sibling",
      title: "Alpha",
      instructions: "alpha work",
    })
    expect(launched).toMatch(/^Detached child "Alpha" launched: /)
    const runId = launched.match(/launched: ([0-9a-f-]+)/i)![1]!
    const sibling = manager.spawn({
      callerThreadId: "stop-sibling",
      title: "Beta",
      instructions: "beta work",
    })
    await eventually(() => signals.size >= 2)
    const record = getDetachedSpawn("stop-sibling", runId)!
    const targetSignal = signals.get(record.childThreadId)
    const siblingId = [...signals.keys()].find((id) => id !== record.childThreadId)!
    const siblingSignal = signals.get(siblingId)!
    expect(targetSignal).toBeDefined()
    expect(siblingSignal.aborted).toBe(false)

    const started = Date.now()
    const result = await stopDelegate("stop-sibling", { runId }, "user")
    expect(Date.now() - started).toBeLessThan(250)
    expect(result.outcome).toBe("cancelled")
    expect(targetSignal!.aborted).toBe(true)
    expect(siblingSignal.aborted).toBe(false)
    expect(leadAbort.signal.aborted).toBe(false)
    await eventually(() => getDetachedSpawn("stop-sibling", runId)?.status === "cancelled")
    expect(signals.get(siblingId)!.aborted).toBe(false)
    manager.dispose()
    void sibling.catch(() => undefined)
  })

  test("STEER-detach runId stop of one child does not abort a sibling spawn or the lead", async () => {
    const leadAbort = new AbortController()
    const signals = new Map<string, AbortSignal>()
    const agent: AgentForSelection = () => ({
      async stream(_input: unknown, config: any) {
        signals.set(config.configurable.thread_id as string, config.signal)
        return (async function* () {
          while (!config.signal.aborted) await Bun.sleep(1)
          throw new DOMException("The operation was aborted.", "AbortError")
        })()
      },
    })
    const manager = new ThreadManager(
      () => undefined,
      "stop-steer-sibling",
      selection,
      agent,
      undefined,
      "/tmp",
      leadAbort,
    )
    const alpha = manager.spawn({
      callerThreadId: "stop-steer-sibling",
      title: "Alpha",
      instructions: "alpha work",
    })
    const beta = manager.spawn({
      callerThreadId: "stop-steer-sibling",
      title: "Beta",
      instructions: "beta work",
    })
    await eventually(() => signals.size >= 2)
    const tool = manager.runSteerDetachable("spawn_thread", "Alpha", alpha)
    let detached = false
    for (let i = 0; i < 80 && !detached; i++) {
      detached = manager.detachForSteer()
      if (!detached) await Bun.sleep(5)
    }
    expect(detached).toBe(true)
    const launched = await tool
    expect(launched).toMatch(/Run id: /)
    const runId = launched.match(/Run id: ([0-9a-f-]+)/i)![1]!
    const record = getDetachedSpawn("stop-steer-sibling", runId)!
    expect(record.childThreadId).toBeDefined()
    expect(signals.has(record.childThreadId)).toBe(true)
    const siblingId = [...signals.keys()].find((id) => id !== record.childThreadId)!
    expect(signals.get(siblingId)!.aborted).toBe(false)

    const started = Date.now()
    const result = await stopDelegate("stop-steer-sibling", { runId }, "user")
    expect(Date.now() - started).toBeLessThan(250)
    expect(result.outcome).toBe("cancelled")
    expect(signals.get(record.childThreadId)!.aborted).toBe(true)
    expect(signals.get(siblingId)!.aborted).toBe(false)
    expect(leadAbort.signal.aborted).toBe(false)
    await eventually(() => getDetachedSpawn("stop-steer-sibling", runId)?.status === "cancelled")
    expect(signals.get(siblingId)!.aborted).toBe(false)
    manager.dispose()
    void beta.catch(() => undefined)
  })

  test("lead stop_delegate tool is registered and rate_delegate refuses cancelled rows", async () => {
    const names = executorToolsFor(selection).tools.map((tool) => tool.name)
    expect(names).toContain("stop_delegate")
    expect(stopDelegateTool.name).toBe("stop_delegate")
    const missing = await runStopDelegate("no-such-session", {}, "lead")
    expect(missing.outcome).toBe("not-found")
    expect(missing.message).toContain("error:")

    Store.createSession("rate-cancelled", "Rate", "/tmp")
    Store.createDelegation({
      id: "cancelled-del",
      sessionId: "rate-cancelled",
      kind: "sidekick",
      provider: "zen",
      model: "test-model",
      briefSnippet: "x",
    })
    Store.completeDelegation("cancelled-del", "cancelled")
    registerThread("rate-cancelled", {
      sessionId: "rate-cancelled",
      spawn: async () => "",
    } as any)
    try {
      const rated = await rateDelegate.invoke({
        delegation: "cancelled-del",
        compliance: 3,
        correctness: 3,
        report: 2,
        reason: "should be refused",
      }, { configurable: { thread_id: "rate-cancelled" } })
      expect(String(rated)).toContain("cancelled")
    } finally {
      unregisterThread("rate-cancelled")
    }
  })
})
