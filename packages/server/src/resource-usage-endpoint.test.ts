import { afterAll, beforeAll, expect, test } from "bun:test"
import type { ResourceUsageResponse } from "@chunky/protocol"
import { ROUTES } from "@chunky/protocol"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { reserveIntegrationServer } from "./test-server.ts"

const root = mkdtempSync(join(tmpdir(), "chunky-resource-endpoint-"))
const dbPath = join(root, "chunky.db")
const settingsPath = join(root, "settings.json")
const token = "resource-endpoint-token"
const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } })
const port = probe.port
probe.stop()
writeFileSync(settingsPath, JSON.stringify({ serverToken: token }))
let server: Bun.Subprocess
const integration = reserveIntegrationServer({ prefix: "chunky-resource-endpoint-", root, port, env: { ...process.env, CHUNKY_PORT: String(port), CHUNKY_SETTINGS: settingsPath, CHUNKY_DB: dbPath, CHUNKY_GRAPH_DB: join(root, "graph.db"), CHUNKY_RELAY: "0", CHUNKY_WORKSPACE: root, CHUNKY_MODELS_CACHE: join(root, "missing-models.json") } })

async function request(path: string): Promise<Response> {
  for (let i = 0; i < 100; i++) {
    try { return await fetch(`http://127.0.0.1:${port}${path}`, { headers: { Authorization: `Bearer ${token}` } }) }
    catch { await Bun.sleep(25) }
  }
  throw new Error("server did not start")
}

beforeAll(async () => {
  const seed = Bun.spawn([process.execPath, "run", "packages/server/src/resource-usage-endpoint-seed-child.ts"], {
    cwd: process.cwd(), env: { ...process.env, CHUNKY_DB: dbPath, CHUNKY_MODELS_CACHE: join(root, "missing-models.json") }, stdout: "pipe", stderr: "pipe",
  })
  const [code, stdout, stderr] = await Promise.all([seed.exited, new Response(seed.stdout).text(), new Response(seed.stderr).text()])
  expect(code, `${stdout}\n${stderr}`).toBe(0)
  server = await integration.start()
})

afterAll(async () => {
  await integration.stop()
})

test("GET usage resources returns the typed percentile payload", async () => {
  expect(ROUTES.usageResources).toBe("/api/usage/resources")
  const response = await request("/api/usage/resources?hours=24")
  expect(response.status).toBe(200)
  const body = await response.json() as ResourceUsageResponse
  expect(body.status).toBe("ok")
  expect(body.intervalMs).toBe(20_000)
  expect(body.windowMs).toBe(24 * 3_600_000)
  expect(body.sampleCount).toBeGreaterThanOrEqual(1)
  expect(body.server.rssBytes.max).toBeGreaterThan(0)
  expect(body.children.rssBytes.max).toBeGreaterThan(0)
  expect(body.total.rssBytes.max).toBe(body.server.rssBytes.max + body.children.rssBytes.max)
  expect(body.peaks[0]?.topTasks[0]?.taskId).toBe("task-1")
})

test("GET usage resources clamps hours and rejects non-numeric values", async () => {
  const clamped = await request("/api/usage/resources?hours=0")
  expect(clamped.status).toBe(200)
  const body = await clamped.json() as ResourceUsageResponse
  expect(body.status).toBe("ok")
  expect(body.windowMs).toBe(3_600_000)
  const high = await request("/api/usage/resources?hours=9999")
  expect((await high.json() as ResourceUsageResponse).windowMs).toBe(720 * 3_600_000)
  const bad = await request("/api/usage/resources?hours=nope")
  expect(bad.status).toBe(400)
})
