import { afterAll, beforeAll, expect, test } from "bun:test"
import type { SessionCacheMetrics } from "@chunky/protocol"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

const root = mkdtempSync(join(tmpdir(), "chunky-cache-endpoint-"))
const dbPath = join(root, "chunky.db")
const settingsPath = join(root, "settings.json")
const sessionId = "cache-endpoint-session"
const token = "cache-endpoint-token"
const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } })
const port = probe.port
probe.stop()
writeFileSync(settingsPath, JSON.stringify({ serverToken: token }))
let server: Bun.Subprocess

async function request(path: string): Promise<Response> {
  for (let i = 0; i < 100; i++) {
    try { return await fetch(`http://127.0.0.1:${port}${path}`, { headers: { Authorization: `Bearer ${token}` } }) }
    catch { await Bun.sleep(25) }
  }
  throw new Error("server did not start")
}

beforeAll(async () => {
  const seed = Bun.spawn([process.execPath, "run", "packages/server/src/usage-cache-endpoint-seed-child.ts"], {
    cwd: process.cwd(), env: { ...process.env, CHUNKY_DB: dbPath, CACHE_ENDPOINT_SESSION: sessionId }, stdout: "pipe", stderr: "pipe",
  })
  const [code, stdout, stderr] = await Promise.all([seed.exited, new Response(seed.stdout).text(), new Response(seed.stderr).text()])
  expect(code, `${stdout}\n${stderr}`).toBe(0)
  server = Bun.spawn([process.execPath, "run", "packages/server/src/index.ts"], {
    cwd: process.cwd(), env: { ...process.env, CHUNKY_PORT: String(port), CHUNKY_SETTINGS: settingsPath, CHUNKY_DB: dbPath,
      CHUNKY_GRAPH_DB: join(root, "graph.db"), CHUNKY_RELAY: "0", CHUNKY_WORKSPACE: root }, stdout: "ignore", stderr: "ignore",
  })
})

afterAll(async () => {
  server?.kill("SIGTERM")
  if (server) await server.exited
  rmSync(root, { recursive: true, force: true })
})

test("GET usage cache returns typed session metrics", async () => {
  const response = await request(`/api/usage/cache?session=${encodeURIComponent(sessionId)}`)
  expect(response.status).toBe(200)
  const body = await response.json() as SessionCacheMetrics
  expect(body).toEqual({
    turns: 2, inputTokens: 40, cacheReadTokens: 90, cacheWriteTokens: 70, promptTokens: 200, cacheHitRate: 0.45,
    coldTurns: 1, unclassifiedTurns: 0, detachedWakeTurns: 1, coldDetachedWakeTurns: 1,
    coldDetachedWakeInputTokens: 30, coldDetachedWakeCacheWriteTokens: 70,
  })
})

test("GET usage cache requires a known session", async () => {
  const missing = await request("/api/usage/cache")
  expect(missing.status).toBe(400)
  expect(await missing.json()).toEqual({ error: "session is required" })
  const unknown = await request("/api/usage/cache?session=missing")
  expect(unknown.status).toBe(400)
  expect(await unknown.json()).toEqual({ error: "unknown session" })
})
