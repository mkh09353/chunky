import { expect, test } from "bun:test"
import {
  getAppZooEndpoint,
  hasAppZoo,
  onAppZooChange,
  resetAppZooEndpoint,
  setAppZooEndpoint,
} from "./app-zoo.ts"
import { buildSystemPrompt } from "./prompt.ts"
import { executorToolsFor, getAgent, invalidateAgent } from "./agent.ts"
import { createChunkySdkMcpServer } from "./anthropic-runner.ts"
import { callZoo, zooTools } from "./tools/zoo.ts"

const SELECTION = { provider: "codex", model: "gpt-5.5" } as const
const TOKEN = "z".repeat(16)
const ZOO_NAMES = zooTools.map((tool) => tool.name)
function toolNames() { return executorToolsFor(SELECTION).tools.map((tool) => tool.name) }
function sdkToolNames() {
  return Object.keys((createChunkySdkMcpServer("app-zoo-test", () => {}).instance as any)._registeredTools)
}
function expectZooTools(names: string[], connected: boolean) {
  for (const name of ZOO_NAMES) expect(names.includes(name)).toBe(connected)
}

test("app zoo endpoint validates credentials, hides its token, and resets", () => {
  resetAppZooEndpoint()
  expect(() => setAppZooEndpoint({ port: 0, token: TOKEN })).toThrow("port")
  expect(() => setAppZooEndpoint({ port: 3010, token: "short" })).toThrow("token")
  setAppZooEndpoint({ port: 3010, token: TOKEN })
  expect(hasAppZoo()).toBe(true)
  expect(getAppZooEndpoint()).toMatchObject({ port: 3010 })
  expect(JSON.stringify({ connected: hasAppZoo() })).not.toContain(TOKEN)
  resetAppZooEndpoint()
  expect(hasAppZoo()).toBe(false)
})

test("app zoo availability listeners only fire on absent/present transitions", () => {
  resetAppZooEndpoint()
  const changes: boolean[] = []
  const unsubscribe = onAppZooChange((connected) => changes.push(connected))
  try {
    setAppZooEndpoint({ port: 3010, token: TOKEN })
    setAppZooEndpoint({ port: 3011, token: "y".repeat(16) })
    resetAppZooEndpoint()
    resetAppZooEndpoint()
    expect(changes).toEqual([true, false])
  } finally {
    unsubscribe()
    resetAppZooEndpoint()
  }
})

test("desktop Zoo prompt guidance and tools are gated in both lead paths", () => {
  resetAppZooEndpoint()
  expect(buildSystemPrompt("edit", false, "/tmp/workspace", { appZoo: hasAppZoo() })).not.toContain("product-factory board")
  expectZooTools(toolNames(), false)
  expectZooTools(sdkToolNames(), false)

  setAppZooEndpoint({ port: 3010, token: TOKEN })
  const prompt = buildSystemPrompt("edit", false, "/tmp/workspace", { appZoo: hasAppZoo() })
  expect(prompt).toContain("product-factory board")
  expect(prompt).toContain("zoo_board/zoo_search/zoo_get_*")
  expectZooTools(toolNames(), true)
  expectZooTools(sdkToolNames(), true)
  resetAppZooEndpoint()
})

test("Zoo availability changes invalidate cached agents but re-announcements do not", () => {
  resetAppZooEndpoint()
  invalidateAgent()
  const absent = getAgent(SELECTION, "/tmp/app-zoo-cache")
  expect(getAgent(SELECTION, "/tmp/app-zoo-cache")).toBe(absent)
  setAppZooEndpoint({ port: 3010, token: TOKEN })
  const present = getAgent(SELECTION, "/tmp/app-zoo-cache")
  expect(present).not.toBe(absent)
  setAppZooEndpoint({ port: 3011, token: "y".repeat(16) })
  expect(getAgent(SELECTION, "/tmp/app-zoo-cache")).toBe(present)
  resetAppZooEndpoint()
  expect(getAgent(SELECTION, "/tmp/app-zoo-cache")).not.toBe(present)
  invalidateAgent()
})

test("Zoo tools authenticate, pass through envelopes, and report unavailable/connection failures", async () => {
  resetAppZooEndpoint()
  const absent = await callZoo("board", {})
  expect(absent.ok).toBe(false)
  expect(absent.promptText).toContain("desktop app isn't running")

  let authorization = ""
  let request: unknown
  const service = Bun.serve({
    port: 0,
    fetch: async (req) => {
      authorization = req.headers.get("authorization") ?? ""
      request = await req.json()
      return Response.json({ ok: true, board: ["source"] })
    },
  })
  try {
    setAppZooEndpoint({ port: service.port!, token: TOKEN })
    const result = await callZoo("board", {})
    expect(authorization).toBe(`Bearer ${TOKEN}`)
    expect(request).toEqual({ method: "board", params: {} })
    expect(result.ok).toBe(true)
    expect(result.promptText).toBe(JSON.stringify({ ok: true, board: ["source"] }))
  } finally {
    service.stop(true)
  }

  setAppZooEndpoint({ port: 1, token: TOKEN })
  const refused = await callZoo("board", {})
  expect(refused.ok).toBe(false)
  expect(refused.promptText).toContain("Zoo service request failed")

  const originalFetch = globalThis.fetch
  // Bun's global fetch also carries static helpers (such as preconnect); this
  // test replaces only the callable implementation for the bounded scope.
  globalThis.fetch = (() => Promise.reject(new DOMException("The operation timed out", "TimeoutError"))) as unknown as typeof fetch
  try {
    const timedOut = await callZoo("board", {})
    expect(timedOut.ok).toBe(false)
    expect(timedOut.promptText).toContain("Zoo service request failed")
    expect(timedOut.promptText).toContain("timed out")
  } finally {
    globalThis.fetch = originalFetch
  }
  resetAppZooEndpoint()
})
