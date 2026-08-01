// The handover the TUI performs when its server is superseded, exercised
// against two real servers: discovery finds the replacement, and the session
// created on the old server replays on the new one (they share the store), so
// reattaching IS resuming.
import { afterAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"

const root = mkdtempSync(join(tmpdir(), "chunky-tui-handover-"))
const workspace = join(root, "workspace")
const serversDir = join(root, "servers")
const token = "handover-test-token"
mkdirSync(workspace, { recursive: true })
mkdirSync(serversDir, { recursive: true })
writeFileSync(join(root, "settings.json"), JSON.stringify({ serverToken: token }))

const { findWorkspaceServer } = await import("./serverDiscovery.js")

// serverDiscovery derives the state directory from CHUNKY_SETTINGS, but bun
// test shares ONE process across files: setting that variable for the whole run
// would point other suites' settings reads at this test's temp directory (and
// at a directory this file deletes when it is done). Set it only for the call
// that needs it, and hand it straight back.
async function discover(...args: Parameters<typeof findWorkspaceServer>): Promise<string | null> {
  const inherited = process.env.CHUNKY_SETTINGS
  process.env.CHUNKY_SETTINGS = join(root, "settings.json")
  try {
    return await findWorkspaceServer(...args)
  } finally {
    if (inherited === undefined) delete process.env.CHUNKY_SETTINGS
    else process.env.CHUNKY_SETTINGS = inherited
  }
}

const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
const repoRoot = join(import.meta.dir, "../../..")

function freePort(): number {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() { return undefined } } })
  const port = listener.port
  listener.stop()
  return port
}

interface Managed {
  port: number
  baseUrl: string
  recordPath: string
  proc: ReturnType<typeof Bun.spawn>
}

/** A launcher-managed server, registered exactly as the launcher registers one. */
function startServer(version: string): Managed {
  const port = freePort()
  const id = randomUUID()
  const nonce = randomUUID()
  const recordPath = join(serversDir, `${version}.json`)
  writeFileSync(recordPath, JSON.stringify({
    schema: 1, id, workspace, version, buildId: `build-${version}`, nonce, port, pid: process.pid, startedAt: Date.now(),
  }))
  const proc = Bun.spawn([process.execPath, "run", "packages/server/src/index.ts"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CHUNKY_PORT: String(port),
      CHUNKY_SETTINGS: join(root, "settings.json"),
      CHUNKY_AUTH: join(root, "auth.json"),
      CHUNKY_DB: join(root, "chunky.db"),
      CHUNKY_GRAPH_DB: join(root, "chunky-graph.db"),
      CHUNKY_RELAY: "0",
      CHUNKY_WORKSPACE: workspace,
      CHUNKY_VERSION: version,
      CHUNKY_BUILD_ID: `build-${version}`,
      CHUNKY_SERVER_NONCE: nonce,
      CHUNKY_SERVER_ID: id,
      CHUNKY_DISCOVERY_RECORD: recordPath,
      CHUNKY_OWNERSHIP_POLL_MS: "150",
      CHUNKY_DRAIN_TIMEOUT_MS: "2000",
    },
    stdout: "ignore",
    stderr: "ignore",
  })
  return { port, baseUrl: `http://localhost:${port}`, recordPath, proc }
}

const servers: Managed[] = []
afterAll(() => {
  for (const server of servers) { try { server.proc.kill() } catch { /* gone */ } }
  rmSync(root, { recursive: true, force: true })
})

/** A session's replayed history, read until `wanted` shows up (or the reader
 *  runs dry). Frames can arrive in any number of chunks — the stream opens with
 *  a `: ready` comment — so this accumulates rather than trusting the first
 *  read, and aborts instead of waiting on the 20s keep-alive. */
async function replayContains(baseUrl: string, sessionId: string, wanted: string): Promise<boolean> {
  const abort = new AbortController()
  const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/events`, { headers: auth, signal: abort.signal })
  if (!res.ok) throw new Error(`events failed (${res.status})`)
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let seen = ""
  try {
    for (let chunk = 0; chunk < 20; chunk++) {
      const read = await Promise.race([
        reader.read(),
        Bun.sleep(2_000).then(() => ({ done: true, value: undefined }) as ReadableStreamReadResult<Uint8Array>),
      ])
      if (read.done) break
      seen += decoder.decode(read.value, { stream: true })
      if (seen.includes(wanted)) return true
    }
    return seen.includes(wanted)
  } finally {
    abort.abort()
  }
}

async function waitUntilServing(server: Managed): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    try {
      const res = await fetch(`${server.baseUrl}/_chunky/server-identity`)
      if (res.ok) return
    } catch { /* not up yet */ }
    await Bun.sleep(25)
  }
  throw new Error(`server on ${server.port} never became ready`)
}

test("a superseded server hands its session over to the replacement", async () => {
  const oldServer = startServer("1.0.0")
  servers.push(oldServer)
  await waitUntilServing(oldServer)

  // A session created against the OLD server.
  const created = await fetch(`${oldServer.baseUrl}/api/sessions`, {
    method: "POST", headers: auth, body: JSON.stringify({ cwd: workspace }),
  })
  expect(created.ok).toBe(true)
  const { sessionId } = await created.json() as { sessionId: string }

  // Give it history on the OLD server. The run itself fails (no provider is
  // configured here), but the user turn is persisted — which is what replay
  // has to reproduce after the handover.
  const marker = "written on the old server"
  const sent = await fetch(`${oldServer.baseUrl}/api/sessions/${sessionId}/messages`, {
    method: "POST", headers: auth, body: JSON.stringify({ text: marker }),
  })
  expect(sent.status).toBe(202)
  expect(await replayContains(oldServer.baseUrl, sessionId, marker)).toBe(true)

  // While only the old server exists, discovery stays with it.
  expect(await discover(workspace)).toBe(oldServer.baseUrl)
  // ...and there is nowhere else to go if we exclude it.
  expect(await discover(workspace, oldServer.baseUrl)).toBeNull()

  // A newer build starts its own server for this workspace, then supersedes the
  // old one by taking its registration away.
  const newServer = startServer("2.0.0")
  servers.push(newServer)
  await waitUntilServing(newServer)
  const supersededAt = Date.now()
  rmSync(oldServer.recordPath, { force: true })

  // The old server announces retirement, so discovery moves us to the new one
  // even before the old process is gone.
  const moved = await (async () => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const found = await discover(workspace, undefined)
      if (found === newServer.baseUrl) return found
      await Bun.sleep(50)
    }
    return null
  })()
  expect(moved).toBe(newServer.baseUrl)

  // Reattaching to the SAME session on the replacement IS resuming: the new
  // server replays the history written on the old one.
  expect(await replayContains(newServer.baseUrl, sessionId, marker)).toBe(true)

  const listed = await fetch(`${newServer.baseUrl}/api/sessions?cwd=${encodeURIComponent(workspace)}`, { headers: auth })
  const { sessions } = await listed.json() as { sessions: { sessionId: string }[] }
  expect(sessions.some((session) => session.sessionId === sessionId)).toBe(true)

  // The superseded server drains and stops serving on its own (nothing was
  // running), so nothing is left pointing clients at the old build.
  const stopped = await (async () => {
    for (let attempt = 0; attempt < 200; attempt++) {
      try {
        const res = await fetch(`${oldServer.baseUrl}/_chunky/server-identity`, { signal: AbortSignal.timeout(500) })
        // Retiring is already the handover signal; gone is the end state.
        if (!res.ok) return true
        const identity = await res.json() as { retiring?: boolean }
        if (identity.retiring) return true
      } catch {
        return true
      }
      await Bun.sleep(50)
    }
    return false
  })()
  expect(stopped).toBe(true)
  expect(Date.now() - supersededAt).toBeLessThan(15_000)
}, 60_000)
