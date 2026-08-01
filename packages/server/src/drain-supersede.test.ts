// End-to-end retirement: a launcher supersedes this server by taking its
// discovery record away. The server must keep the in-flight turn (and its
// stream) alive, advertise `retiring`, refuse NEW turns, and exit only after
// the drain timeout aborts what is left.
//
// The "agent" is a fake OpenAI-compatible endpoint that accepts the request and
// never answers, which is exactly the shape of a long turn.
import { afterAll, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"

const root = mkdtempSync(join(tmpdir(), "chunky-drain-"))
const token = "drain-test-token"
const DRAIN_TIMEOUT_MS = 2_000

function freePort(): number {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() { return undefined } } })
  const port = listener.port
  listener.stop()
  return port
}

// ---- the fake provider: accepts the completion, then hangs forever ---------
let providerHits = 0
const provider = Bun.serve({
  port: 0,
  fetch(req) {
    const path = new URL(req.url).pathname
    if (path.endsWith("/models")) {
      return Response.json({ data: [{ id: "faux-model", object: "model" }] })
    }
    providerHits++
    // Never resolves: the turn stays in flight until the server aborts it.
    return new Promise<Response>(() => {})
  },
})

const serverPort = freePort()
const baseUrl = `http://127.0.0.1:${serverPort}`
const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
const recordPath = join(root, "discovery.json")
const serverId = randomUUID()
const nonce = randomUUID()

writeFileSync(join(root, "settings.json"), JSON.stringify({
  serverToken: token,
  provider: "faux",
  selections: { faux: { model: "faux-model" } },
  customProviders: [{
    id: "faux",
    label: "Faux",
    baseURL: `http://127.0.0.1:${provider.port}/v1`,
    billing: "metered",
    defaultModel: "faux-model",
    key: "faux-key",
  }],
}))
// The provider's key lives in the auth store, not in settings.
writeFileSync(join(root, "auth.json"), JSON.stringify({ faux: { type: "api", key: "faux-key" } }))
// The launcher writes this before the server boots; deleting it is how a
// successor says "you are superseded".
writeFileSync(recordPath, JSON.stringify({
  schema: 1, id: serverId, workspace: root, version: "9.9.9", buildId: "testbuild",
  nonce, port: serverPort, pid: process.pid, startedAt: Date.now(),
}))

const proc = Bun.spawn([process.execPath, "run", "packages/server/src/index.ts"], {
  cwd: join(import.meta.dir, "../../.."),
  env: {
    ...process.env,
    CHUNKY_PORT: String(serverPort),
    CHUNKY_SETTINGS: join(root, "settings.json"),
    CHUNKY_DB: join(root, "chunky.db"),
    CHUNKY_GRAPH_DB: join(root, "chunky-graph.db"),
    CHUNKY_AUTH: join(root, "auth.json"),
    CHUNKY_RELAY: "0",
    CHUNKY_WORKSPACE: root,
    CHUNKY_VERSION: "9.9.9",
    CHUNKY_BUILD_ID: "testbuild",
    CHUNKY_SERVER_NONCE: nonce,
    CHUNKY_SERVER_ID: serverId,
    CHUNKY_DISCOVERY_RECORD: recordPath,
    CHUNKY_OWNERSHIP_POLL_MS: "150",
    CHUNKY_DRAIN_TIMEOUT_MS: String(DRAIN_TIMEOUT_MS),
  },
  stdout: "ignore",
  stderr: "ignore",
})

afterAll(() => {
  try { proc.kill() } catch { /* already gone */ }
  provider.stop(true)
  rmSync(root, { recursive: true, force: true })
})

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

async function until<T>(what: string, probe: () => Promise<T | null>, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await probe()
    if (value !== null && value !== undefined) return value
    await Bun.sleep(50)
  }
  throw new Error(`timed out waiting for ${what}`)
}

type Identity = { retiring?: boolean; version?: string; retiringDeadline?: number | null }
async function identity(): Promise<Identity> {
  return await (await request("/_chunky/server-identity")).json() as Identity
}

test("a superseded server drains its in-flight turn, refuses new ones, then exits", async () => {
  // 1. Healthy: identity answers and is not retiring.
  const healthy = await until("the server to boot", async () => {
    const res = await request("/_chunky/server-identity")
    return res.ok ? (await res.json()) as Identity : null
  })
  expect(healthy.version).toBe("9.9.9")
  expect(healthy.retiring).toBe(false)

  // 2. Start a turn. The fake provider hangs, so it stays in flight.
  const created = await request("/api/sessions", { method: "POST", headers: auth, body: "{}" })
  expect(created.ok).toBe(true)
  const { sessionId } = await created.json() as { sessionId: string }

  const send = await request(`/api/sessions/${sessionId}/messages`, {
    method: "POST", headers: auth, body: JSON.stringify({ text: "hold the line" }),
  })
  expect(send.status).toBe(202)
  await until("the run to reach the provider", async () => (providerHits > 0 ? true : null))

  // 3. Supersede: the launcher takes the registration away.
  rmSync(recordPath, { force: true })

  // 4. The server announces retirement but stays up with the turn in flight.
  const retiring = await until("the retiring flag", async () => {
    const value = await identity()
    return value.retiring === true ? value : null
  })
  expect(retiring.retiringDeadline).toBeGreaterThan(Date.now() - 1_000)
  expect(proc.exitCode).toBeNull()

  // 5. New work is refused with a reconnect hint; reads still work.
  const refused = await request(`/api/sessions/${sessionId}/messages`, {
    method: "POST", headers: auth, body: JSON.stringify({ text: "start something new" }),
  })
  expect(refused.status).toBe(503)
  expect((await refused.json() as { error: string }).error).toContain("Reconnect")

  const stillReadable = await request("/api/sessions", { headers: auth })
  expect(stillReadable.ok).toBe(true)

  // 6. The stuck turn outlives the drain timeout, so it is aborted and the
  //    server exits on its own — and it leaves no registration behind.
  const exited = await Promise.race([
    proc.exited,
    Bun.sleep(DRAIN_TIMEOUT_MS + 20_000).then(() => "timeout" as const),
  ])
  expect(exited).not.toBe("timeout")
  expect(existsSync(recordPath)).toBe(false)
}, 60_000)
