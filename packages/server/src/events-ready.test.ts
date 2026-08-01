// Attaching to a session must connect immediately, even when it has no history
// yet: clients only consider a stream open once the first byte arrives, and the
// next one after that can be the 20s keep-alive.
import { afterAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const root = mkdtempSync(join(tmpdir(), "chunky-events-ready-"))
const token = "events-ready-token"
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
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      return await fetch(baseUrl + path, init)
    } catch (error) {
      last = error
      await Bun.sleep(25)
    }
  }
  throw last
}

test("an empty session's event stream opens without waiting for the keep-alive", async () => {
  const created = await request("/api/sessions", { method: "POST", headers: auth, body: "{}" })
  expect(created.ok).toBe(true)
  const { sessionId } = await created.json() as { sessionId: string }

  const abort = new AbortController()
  const startedAt = Date.now()
  const events = await request(`/api/sessions/${sessionId}/events`, { headers: auth, signal: abort.signal })
  expect(events.ok).toBe(true)

  const reader = events.body!.getReader()
  const { value } = await reader.read()
  const first = new TextDecoder().decode(value ?? new Uint8Array())
  abort.abort()

  // The keep-alive is 20s away; this must arrive in a fraction of that.
  expect(Date.now() - startedAt).toBeLessThan(5_000)
  expect(first).toContain(": ready")
}, 30_000)
