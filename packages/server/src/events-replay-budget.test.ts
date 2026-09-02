import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  encodeSessionEventCursor,
  readSessionEventStream,
  type AgentEvent,
  type SessionEventCursor,
  type SessionEventStreamFrame,
} from "@chunky/protocol"
import { reserveIntegrationServer } from "./test-server.ts"

// The server under test runs with a tiny event budget so a handful of rows is
// "too large" for a cursor catch-up, while cold (no-cursor) attaches must still
// replay everything through the paged path (> one 200-row page).
const MAX_EVENTS = 3
const root = mkdtempSync(join(tmpdir(), "chunky-events-replay-budget-"))
const token = "events-replay-budget-token"
const dbPath = join(root, "chunky.db")
const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } })
const port = listener.port
listener.stop()

writeFileSync(join(root, "settings.json"), JSON.stringify({ serverToken: token }))
const server = reserveIntegrationServer({ prefix: "chunky-events-replay-budget-", root, port, env: {
    ...process.env,
    CHUNKY_PORT: String(port),
    CHUNKY_SETTINGS: join(root, "settings.json"),
    CHUNKY_AUTH: join(root, "auth.json"),
    CHUNKY_DB: dbPath,
    CHUNKY_GRAPH_DB: join(root, "graph.db"),
    CHUNKY_MODELS_CACHE: join(root, "missing-models-cache.json"),
    CHUNKY_RELAY: "0",
    CHUNKY_WORKSPACE: root,
    CHUNKY_REPLAY_MAX_EVENTS: String(MAX_EVENTS),
  } })
const base = `http://127.0.0.1:${port}`
const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
let db: Database

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  let error: unknown
  for (let i = 0; i < 200; i++) {
    try { return await fetch(base + path, init) } catch (cause) { error = cause; await Bun.sleep(25) }
  }
  throw error
}

async function createSession(): Promise<string> {
  const response = await request("/api/sessions", { method: "POST", headers: auth, body: "{}" })
  expect(response.ok).toBe(true)
  return (await response.json() as { sessionId: string }).sessionId
}

function generation(id: string): string {
  return (db.query("SELECT history_generation generation FROM sessions WHERE id=?").get(id) as { generation: string }).generation
}

function append(id: string, events: AgentEvent[]): void {
  const next = db.query("SELECT COALESCE(MAX(seq),-1)+1 n FROM events WHERE session_id=?")
  const insert = db.query("INSERT INTO events (session_id,seq,json) VALUES (?,?,?)")
  db.transaction(() => {
    for (const event of events) insert.run(id, (next.get(id) as { n: number }).n, JSON.stringify(event))
  })()
}

function rangeStats(id: string, from: number, to: number): { events: number; bytes: number } {
  return db.query("SELECT COUNT(*) events, COALESCE(SUM(length(json)),0) bytes FROM events WHERE session_id=? AND seq>=? AND seq<?").get(id, from, to) as { events: number; bytes: number }
}

function deltas(count: number, prefix = "d"): AgentEvent[] {
  return Array.from({ length: count }, (_, n) => ({ type: "message.delta", text: `${prefix}${n}` } as AgentEvent))
}

async function openV2(id: string, cursor?: SessionEventCursor) {
  const query = cursor ? `&cursor=${encodeURIComponent(encodeSessionEventCursor(cursor))}` : ""
  const abort = new AbortController()
  const response = await request(`/api/sessions/${id}/events?stream=v2${query}`, { headers: auth, signal: abort.signal })
  const iterator = readSessionEventStream(response)[Symbol.asyncIterator]()
  return { response, abort, next: async () => {
    const result = await Promise.race([iterator.next(), Bun.sleep(5_000).then(() => { throw new Error("timed out waiting for SSE frame") })])
    return result.value!
  } }
}

type ParsedFrame = SessionEventStreamFrame | { kind: "legacy"; event: AgentEvent }
async function initial(stream: Awaited<ReturnType<typeof openV2>>, count: number): Promise<ParsedFrame[]> {
  const frames: ParsedFrame[] = []
  for (let i = 0; i < count; i++) frames.push(await stream.next())
  stream.abort.abort()
  return frames
}

beforeAll(async () => {
  await server.start()
  await request("/api/info", { headers: auth })
  db = new Database(dbPath)
})
afterAll(async () => {
  db?.close()
  await server.stop()
})

describe("v2 replay budget", () => {
  test("cursor supplied and over budget -> 400 replay-too-large with the boundary cursor", async () => {
    const id = await createSession()
    append(id, deltas(MAX_EVENTS + 3))
    const cursor = { generation: generation(id), nextSeq: 0 }
    const response = await request(`/api/sessions/${id}/events?stream=v2&cursor=${encodeURIComponent(encodeSessionEventCursor(cursor))}`, { headers: auth })
    expect(response.status).toBe(400)
    expect(response.headers.get("Content-Type")).toContain("application/json")
    const stats = rangeStats(id, 0, MAX_EVENTS + 3)
    expect(await response.json()).toEqual({
      error: "session event replay too large",
      code: "replay-too-large",
      cursor: encodeSessionEventCursor({ generation: generation(id), nextSeq: MAX_EVENTS + 3 }),
      events: MAX_EVENTS + 3,
      bytes: stats.bytes,
    })
    expect(stats.events).toBe(MAX_EVENTS + 3)
    expect(stats.bytes).toBeGreaterThan(0)
  })

  test("cursor-ahead and history-rewritten resets are budgeted from zero", async () => {
    const id = await createSession()
    append(id, deltas(MAX_EVENTS + 1))
    const boundary = MAX_EVENTS + 1
    const ahead = await request(`/api/sessions/${id}/events?stream=v2&cursor=${encodeURIComponent(encodeSessionEventCursor({ generation: generation(id), nextSeq: 99 }))}`, { headers: auth })
    expect(ahead.status).toBe(400)
    expect(await ahead.json()).toMatchObject({ code: "replay-too-large", events: boundary, cursor: encodeSessionEventCursor({ generation: generation(id), nextSeq: boundary }) })

    const rewritten = await request(`/api/sessions/${id}/events?stream=v2&cursor=${encodeURIComponent(encodeSessionEventCursor({ generation: crypto.randomUUID(), nextSeq: boundary }))}`, { headers: auth })
    expect(rewritten.status).toBe(400)
    expect(await rewritten.json()).toMatchObject({ code: "replay-too-large", events: boundary })
  })

  test("a rejected request leaves no subscriber behind: the next attach still replays", async () => {
    const id = await createSession()
    append(id, deltas(MAX_EVENTS + 2))
    const rejected = await request(`/api/sessions/${id}/events?stream=v2&cursor=${encodeURIComponent(encodeSessionEventCursor({ generation: generation(id), nextSeq: 0 }))}`, { headers: auth })
    expect(rejected.status).toBe(400)
    const frames = await initial(await openV2(id, { generation: generation(id), nextSeq: MAX_EVENTS }), 4)
    expect(frames.map((frame) => frame.kind)).toEqual(["event", "event", "replay-end", "live"])
  })

  test("no cursor -> full paged replay arrives in order and ends with replay-end at the boundary", async () => {
    const id = await createSession()
    // More than two 200-row pages and far beyond the 3-event budget.
    const total = 450
    append(id, deltas(total))
    const stream = await openV2(id)
    const frames = await initial(stream, total + 2)
    const events = frames.slice(0, total) as Array<Extract<SessionEventStreamFrame, { kind: "event" }>>
    expect(events.every((frame) => frame.kind === "event")).toBe(true)
    expect(events.map((frame) => frame.seq)).toEqual(Array.from({ length: total }, (_, n) => n))
    expect(events.map((frame) => frame.cursor.nextSeq)).toEqual(Array.from({ length: total }, (_, n) => n + 1))
    expect(events.every((frame) => frame.cursor.generation === generation(id))).toBe(true)
    expect((events[total - 1]!.event as { text: string }).text).toBe(`d${total - 1}`)
    expect(frames[total]).toEqual({ kind: "replay-end", cursor: { generation: generation(id), nextSeq: total } })
    expect(frames[total + 1]).toMatchObject({ kind: "live", event: { type: "ports.changed" } })
  }, 20_000)

  test("an exact page multiple still terminates with replay-end", async () => {
    const id = await createSession()
    append(id, deltas(200))
    const frames = await initial(await openV2(id), 202)
    expect(frames[199]).toMatchObject({ kind: "event", seq: 199 })
    expect(frames[200]).toEqual({ kind: "replay-end", cursor: { generation: generation(id), nextSeq: 200 } })
    expect(frames[201]).toMatchObject({ kind: "live", event: { type: "ports.changed" } })
  }, 20_000)

  test("cursor within budget -> only the suffix is replayed", async () => {
    const id = await createSession()
    append(id, deltas(10))
    const frames = await initial(await openV2(id, { generation: generation(id), nextSeq: 8 }), 4)
    expect(frames.map((frame: any) => [frame.kind, frame.seq ?? null])).toEqual([["event", 8], ["event", 9], ["replay-end", null], ["live", null]])
    expect(frames[2]).toEqual({ kind: "replay-end", cursor: { generation: generation(id), nextSeq: 10 } })
  })

  test("cursor exactly at the budget is allowed", async () => {
    const id = await createSession()
    append(id, deltas(10))
    const frames = await initial(await openV2(id, { generation: generation(id), nextSeq: 10 - MAX_EVENTS }), MAX_EVENTS + 2)
    expect(frames.slice(0, MAX_EVENTS).map((frame: any) => frame.seq)).toEqual([7, 8, 9])
    expect(frames[MAX_EVENTS]).toMatchObject({ kind: "replay-end", cursor: { nextSeq: 10 } })
  })

  test("cursor at the boundary sends replay-end then live even on an over-budget session", async () => {
    const id = await createSession()
    append(id, deltas(MAX_EVENTS + 5))
    const frames = await initial(await openV2(id, { generation: generation(id), nextSeq: MAX_EVENTS + 5 }), 2)
    expect(frames.map((frame) => frame.kind)).toEqual(["replay-end", "live"])
  })

  test("invalid cursor keeps the existing 400 body", async () => {
    const id = await createSession()
    const response = await request(`/api/sessions/${id}/events?stream=v2&cursor=not!base64`, { headers: auth })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: "invalid session event cursor" })
  })

  test("live frames persisted after a cold attach follow replay-end exactly once", async () => {
    const id = await createSession()
    append(id, deltas(5))
    const stream = await openV2(id)
    const frames = await initial(stream, 7)
    expect(frames.map((frame) => frame.kind)).toEqual(["event", "event", "event", "event", "event", "replay-end", "live"])
    expect(frames[5]).toEqual({ kind: "replay-end", cursor: { generation: generation(id), nextSeq: 5 } })
  })
})
