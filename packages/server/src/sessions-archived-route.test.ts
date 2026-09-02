import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ListSessionsResponse, SessionDelta, SessionSummary, ShellSessionsResponse } from "@chunky/protocol"
import { integrationServerEnvironment, reserveIntegrationServer } from "./test-server.ts"

// GET /api/sessions is live-only, `archived=1` lists the cold sessions of a
// repository, and the cross-repository stream never carries cold rows.
// realpath: `cwd=` is canonicalized by the server, so the workspace the
// sessions are pinned to must already be the canonical spelling.
const root = mkdtempSync(join(realpathSync(tmpdir()), "chunky-sessions-archived-"))
const token = "sessions-archived-token"
const provider = Bun.serve({
  port: 0,
  fetch(req) {
    if (new URL(req.url).pathname.endsWith("/models")) return Response.json({ data: [{ id: "faux-model", object: "model" }] })
    return new Response("unused", { status: 500 })
  },
})
writeFileSync(join(root, "settings.json"), JSON.stringify({
  serverToken: token,
  provider: "faux",
  selections: { faux: { model: "faux-model" } },
  customProviders: [{ id: "faux", label: "Faux", baseURL: `http://127.0.0.1:${provider.port}/v1`, billing: "metered", defaultModel: "faux-model" }],
}))
writeFileSync(join(root, "auth.json"), JSON.stringify({ faux: { type: "api", key: "faux-key" } }))
const server = reserveIntegrationServer({ prefix: "chunky-sessions-archived-", root, env: { ...process.env } })
const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }

// There is no HTTP route that archives on demand, so the archive step runs in
// a child process against the server's database and state directory. Never in
// THIS process: importing the Store here would bind the singleton to whichever
// database the first test file of the run configured.
async function archiveSession(sessionId: string): Promise<boolean> {
  const proc = Bun.spawn([process.execPath, "run", "packages/server/src/session-archive-child.ts", sessionId], {
    cwd: join(import.meta.dir, "../../.."),
    env: integrationServerEnvironment({ prefix: "chunky-sessions-archived-", root, env: { ...process.env } }, root, 0),
    stdout: "pipe", stderr: "pipe",
  })
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  if (code !== 0) throw new Error(`archive child exited ${code}: ${await new Response(proc.stderr).text()}`)
  return out.trim() === "true"
}

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  let error: unknown
  for (let i = 0; i < 200; i++) {
    try { return await fetch(server.baseUrl + path, init) } catch (cause) { error = cause; await Bun.sleep(25) }
  }
  throw error
}
async function createSession(): Promise<string> {
  const response = await request("/api/sessions", { method: "POST", headers: auth, body: "{}" })
  expect(response.ok).toBe(true)
  return (await response.json() as { sessionId: string }).sessionId
}
async function listSessions(query = ""): Promise<SessionSummary[]> {
  const response = await request(`/api/sessions${query}`, { headers: auth })
  expect(response.status).toBe(200)
  return (await response.json() as ListSessionsResponse).sessions
}
const ids = (rows: SessionSummary[]) => rows.map((s) => s.sessionId)

/** Minimal SSE frame reader for the session stream (comments/pings are skipped). */
function openStream(response: Response) {
  const reader = response.body!.getReader(), decoder = new TextDecoder()
  let buffer = ""
  const next = async (): Promise<{ event: string; data: unknown }> => {
    for (;;) {
      const end = buffer.indexOf("\n\n")
      if (end >= 0) {
        const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2)
        const lines = frame.split("\n"), event = lines.find((l) => l.startsWith("event: "))?.slice(7)
        const data = lines.filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n")
        if (event) return { event, data: JSON.parse(data) }
        continue
      }
      const chunk = await Promise.race([reader.read(), Bun.sleep(5_000).then(() => { throw new Error("timed out waiting for stream frame") })])
      if (chunk.done) throw new Error("stream closed")
      buffer += decoder.decode(chunk.value, { stream: true })
    }
  }
  return { next, close: () => reader.cancel().catch(() => undefined) }
}

let live: string, cold: string, workspace: string
beforeAll(async () => {
  await server.start()
  live = await createSession()
  cold = await createSession()
  workspace = (await listSessions()).find((s) => s.sessionId === cold)!.workspace!
  expect(await archiveSession(cold)).toBe(true)
})
afterAll(async () => {
  await server.stop()
  provider.stop(true)
})

describe("archived session lists", () => {
  test("default and cwd lists are live-only", async () => {
    for (const query of ["", `?cwd=${encodeURIComponent(workspace)}`]) {
      const rows = await listSessions(query)
      expect(ids(rows)).toContain(live)
      expect(ids(rows)).not.toContain(cold)
      expect(rows.some((s) => s.archived)).toBe(false)
    }
  })

  test("archived=1 returns only the repository's cold sessions", async () => {
    for (const query of ["?archived=1", `?cwd=${encodeURIComponent(workspace)}&archived=1`]) {
      const rows = await listSessions(query)
      expect(ids(rows)).toEqual([cold])
      expect(rows[0]).toMatchObject({ archived: true, workspace, attached: false, running: false, busy: false, incognito: false })
    }
  })

  test("archived=1 rejects scope=none", async () => {
    const response = await request("/api/sessions?scope=none&archived=1", { headers: auth })
    expect(response.status).toBe(400)
    expect(ids(await listSessions("?scope=none"))).not.toContain(cold)
  })

  test("the mobile shell list still includes cold rows", async () => {
    const response = await request("/api/sessions/shell", { headers: auth })
    const { sessions } = await response.json() as ShellSessionsResponse
    expect(sessions.find((s) => s.sessionId === cold)).toMatchObject({ archived: true })
    expect(sessions.find((s) => s.sessionId === live)?.archived).toBeUndefined()
  })

  test("stream snapshot excludes cold rows and a rehydrated session arrives as upsert", async () => {
    const stream = openStream(await request("/api/sessions/stream", { headers: auth }))
    try {
      const snapshot = await stream.next()
      expect(snapshot.event).toBe("snapshot")
      const sessions = (snapshot.data as ShellSessionsResponse).sessions
      expect(ids(sessions)).toContain(live)
      expect(ids(sessions)).not.toContain(cold)
      expect(sessions.some((s) => s.archived)).toBe(false)

      // Opening the cold session by id rehydrates it on the server.
      const history = await request(`/api/sessions/${cold}/history`, { headers: auth })
      expect(history.status).toBe(200)
      let delta: SessionDelta
      for (;;) {
        const frame = await stream.next()
        expect(frame.event).toBe("delta")
        delta = frame.data as SessionDelta
        if (delta.upsert.some((s) => s.sessionId === cold) || delta.remove.includes(cold)) break
      }
      expect(delta.remove).not.toContain(cold)
      expect(delta.upsert.find((s) => s.sessionId === cold)).toMatchObject({ workspace, running: false })
      expect(delta.upsert.find((s) => s.sessionId === cold)?.archived).toBeUndefined()

      expect(ids(await listSessions("?archived=1"))).toEqual([])
      expect(ids(await listSessions())).toContain(cold)
    } finally {
      await stream.close()
    }
  })
})
