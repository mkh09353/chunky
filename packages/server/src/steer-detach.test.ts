import { afterEach, expect, test } from "bun:test"
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
