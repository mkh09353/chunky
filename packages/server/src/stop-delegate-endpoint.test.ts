import { afterAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { StopDelegateResponse } from "@chunky/protocol"

const root = mkdtempSync(join(tmpdir(), "chunky-stop-delegate-http-"))
const token = "stop-delegate-token"
const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() { return undefined } } })
const port = listener.port
listener.stop()

writeFileSync(join(root, "settings.json"), JSON.stringify({ serverToken: token }))
const proc = Bun.spawn([process.execPath, "run", "packages/server/src/index.ts"], {
  cwd: join(import.meta.dir, "../../.."),
  env: {
    ...process.env,
    CHUNKY_PORT: String(port),
    CHUNKY_SETTINGS: join(root, "settings.json"),
    CHUNKY_DB: join(root, "chunky.db"),
    CHUNKY_GRAPH_DB: join(root, "chunky-graph.db"),
    CHUNKY_RELAY: "0",
    CHUNKY_WORKSPACE: root,
    CHUNKY_MODELS_CACHE: join(root, "missing-models.json"),
  },
  stdout: "ignore",
  stderr: "ignore",
})

afterAll(() => {
  try { proc.kill() } catch { /* already gone */ }
  rmSync(root, { recursive: true, force: true })
})

const baseUrl = `http://127.0.0.1:${port}`
const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  let last: unknown
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      return await fetch(baseUrl + path, init)
    } catch (error) {
      last = error
      await Bun.sleep(25)
    }
  }
  throw last
}

test("POST stop-delegate is authenticated and idempotent for an idle session", async () => {
  const unauthorized = await request("/api/sessions/missing/stop-delegate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  })
  expect(unauthorized.status).toBe(401)

  const created = await request("/api/sessions", { method: "POST", headers: auth, body: "{}" })
  expect(created.ok).toBe(true)
  const { sessionId } = await created.json() as { sessionId: string }

  const delegates = await request(`/api/sessions/${sessionId}/delegates`, { headers: auth })
  expect(delegates.status).toBe(200)
  expect(await delegates.json()).toEqual({ runs: [] })

  const missing = await request(`/api/sessions/${sessionId}/stop-delegate`, {
    method: "POST",
    headers: auth,
    body: "{}",
  })
  expect(missing.status).toBe(404)
  const body = await missing.json() as StopDelegateResponse
  expect(body.outcome).toBe("not-found")
  expect(body.message).toContain("error:")

  const unknownSession = await request("/api/sessions/does-not-exist/stop-delegate", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ runId: "nope" }),
  })
  expect(unknownSession.status).toBe(404)
  expect(await unknownSession.json()).toEqual({ error: "unknown session" })

  const started = Date.now()
  const prompt = await request(`/api/sessions/${sessionId}/stop-delegate`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ seat: "frontend" }),
  })
  expect(Date.now() - started).toBeLessThan(1_000)
  expect(prompt.status).toBe(404)
  expect(((await prompt.json()) as StopDelegateResponse).outcome).toBe("not-found")
}, 30_000)
