import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  decodeSessionHistoryPageCursor,
  encodeSessionHistoryPageCursor,
  type AgentEvent,
  type SessionHistoryResponse,
} from "@chunky/protocol"
import { reserveIntegrationServer } from "./test-server.ts"

const root = mkdtempSync(join(tmpdir(), "chunky-history-page-"))
const token = "history-page-token"
const dbPath = join(root, "chunky.db")
const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } })
const port = listener.port
listener.stop()

writeFileSync(join(root, "settings.json"), JSON.stringify({ serverToken: token }))
const server = reserveIntegrationServer({ prefix: "chunky-history-page-", root, port, env: {
    ...process.env,
    CHUNKY_PORT: String(port),
    CHUNKY_SETTINGS: join(root, "settings.json"),
    CHUNKY_AUTH: join(root, "auth.json"),
    CHUNKY_DB: dbPath,
    CHUNKY_GRAPH_DB: join(root, "graph.db"),
    CHUNKY_MODELS_CACHE: join(root, "missing-models-cache.json"),
    CHUNKY_RELAY: "0",
    CHUNKY_WORKSPACE: root,
  } })
const base = `http://127.0.0.1:${port}`
const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
let db: Database

async function request(path: string): Promise<Response> {
  let error: unknown
  for (let i = 0; i < 200; i++) {
    try { return await fetch(base + path, { headers: auth }) } catch (cause) { error = cause; await Bun.sleep(25) }
  }
  throw error
}

async function createSession(): Promise<string> {
  const response = await fetch(base + "/api/sessions", { method: "POST", headers: auth, body: "{}" })
  expect(response.ok).toBe(true)
  return (await response.json() as { sessionId: string }).sessionId
}

function append(id: string, event: AgentEvent): number {
  const seq = (db.query("SELECT COALESCE(MAX(seq),-1)+1 n FROM events WHERE session_id=?").get(id) as { n: number }).n
  db.query("INSERT INTO events (session_id,seq,json) VALUES (?,?,?)").run(id, seq, JSON.stringify(event))
  return seq
}

function appendTurn(id: string, text: string, extras: AgentEvent[] = []): number {
  const start = (db.query("SELECT COALESCE(MAX(seq),-1)+1 n FROM events WHERE session_id=?").get(id) as { n: number }).n
  const turn = (db.query("SELECT COALESCE(MAX(turn_index),0)+1 n FROM session_turns WHERE session_id=?").get(id) as { n: number }).n
  db.query("INSERT INTO session_turns (session_id,turn_index,start_event_seq,user_text,status,created_at) VALUES (?,?,?,?,?,?)")
    .run(id, turn, start, text, "complete", Date.now())
  append(id, { type: "message.user", text })
  for (const event of extras) append(id, event)
  append(id, { type: "message.delta", text: `answer-${text}` })
  return start
}

async function history(id: string, query = ""): Promise<{ response: Response; body: SessionHistoryResponse }> {
  const response = await request(`/api/sessions/${id}/history${query}`)
  return { response, body: await response.json() as SessionHistoryResponse }
}

beforeAll(async () => {
  await server.start()
  await request("/api/info")
  db = new Database(dbPath)
})

afterAll(async () => {
  db?.close()
  await server.stop()
})

describe("bounded session history pages", () => {
  test("tail with fewer than N turns returns all events", async () => {
    const id = await createSession()
    append(id, { type: "session.status", sessionId: id, status: "idle" })
    appendTurn(id, "one")
    appendTurn(id, "two")

    const { response, body } = await history(id, "?turns=10")
    expect(response.status).toBe(200)
    expect(body.events.map((row) => row.seq)).toEqual([0, 1, 2, 3, 4])
    expect(body.hasMore).toBe(false)
    expect(body.before).toBeNull()
    expect(body.firstSeq).toBe(0)
    expect(body.lastSeq).toBe(4)
    expect(body.cursor.nextSeq).toBe(5)
    expect(body.events.every((row) => row.seq < body.cursor.nextSeq)).toBe(true)
  })

  test("tail and older pages are disjoint contiguous turn ranges", async () => {
    const id = await createSession()
    append(id, { type: "session.status", sessionId: id, status: "idle" })
    appendTurn(id, "one")
    appendTurn(id, "two")
    appendTurn(id, "three")
    const child: AgentEvent = { type: "message.user", text: "child", threadId: "child-1" }
    appendTurn(id, "four", [child])
    appendTurn(id, "five")

    const tail = (await history(id, "?turns=2")).body
    expect(tail.hasMore).toBe(true)
    expect(tail.before).not.toBeNull()
    expect(tail.events.map((row) => row.seq)).toEqual([7, 8, 9, 10, 11])
    expect(tail.events.some((row) => row.event.type === "message.user" && row.event.threadId === "child-1")).toBe(true)

    const tailBeforeSeq = decodeSessionHistoryPageCursor(tail.before!)!.beforeSeq
    const middle = (await history(id, `?turns=2&before=${encodeURIComponent(tail.before!)}`)).body
    expect(middle.events.map((row) => row.seq)).toEqual([3, 4, 5, 6])
    expect(middle.events.every((row) => row.seq < tailBeforeSeq)).toBe(true)
    expect(middle.hasMore).toBe(true)
    expect(new Set([...tail.events, ...middle.events].map((row) => row.seq)).size).toBe(tail.events.length + middle.events.length)

    const oldest = (await history(id, `?turns=2&before=${encodeURIComponent(middle.before!)}`)).body
    expect(oldest.events.map((row) => row.seq)).toEqual([0, 1, 2])
    expect(oldest.events[0]!.event).toEqual({ type: "session.status", sessionId: id, status: "idle" })
    expect(oldest.hasMore).toBe(false)
    expect(oldest.before).toBeNull()
  })

  test("rewritten page cursor returns 409 with the current stream cursor", async () => {
    const id = await createSession()
    appendTurn(id, "one")
    appendTurn(id, "two")
    const first = (await history(id, "?turns=1")).body
    const oldPage = decodeSessionHistoryPageCursor(first.before!)!
    const generation = crypto.randomUUID()
    db.query("UPDATE sessions SET history_generation=? WHERE id=?").run(generation, id)

    const response = await request(`/api/sessions/${id}/history?before=${encodeURIComponent(encodeSessionHistoryPageCursor(oldPage))}`)
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: "history-rewritten", cursor: { generation, nextSeq: 4 } })
  })

  test("parameters are validated, turns are clamped, and unknown sessions are 404", async () => {
    const id = await createSession()
    appendTurn(id, "one")
    expect((await request(`/api/sessions/${id}/history?turns=1.5`)).status).toBe(400)
    expect((await request(`/api/sessions/${id}/history?before=bad!cursor`)).status).toBe(400)
    expect((await request("/api/sessions/missing/history")).status).toBe(404)
    expect((await history(id, "?turns=0")).body.events.length).toBe(2)
    expect((await history(id, "?turns=1000")).body.events.length).toBe(2)
  })
})
