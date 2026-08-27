import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  encodeSessionEventCursor,
  readSessionEventStream,
  type AgentEvent,
  type SessionEventCursor,
  type SessionEventStreamFrame,
} from "@chunky/protocol"

const root = mkdtempSync(join(tmpdir(), "chunky-events-cursor-"))
const token = "events-cursor-token"
const dbPath = join(root, "chunky.db")
const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } })
const port = listener.port
listener.stop()

const provider = Bun.serve({
  port: 0,
  async fetch(req) {
    if (new URL(req.url).pathname.endsWith("/models")) return Response.json({ data: [{ id: "faux-model", object: "model" }] })
    const body = await req.text()
    const requestTool = body.includes("produce tool progress") && !body.includes('"role":"tool"')
    const enc = new TextEncoder()
    return new Response(new ReadableStream({
      start(controller) {
        const chunk = (delta: object, finish_reason: string | null = null) => controller.enqueue(enc.encode(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: "faux-model", choices: [{ index: 0, delta, finish_reason }] })}\n\n`))
        chunk({ role: "assistant", content: "" })
        if (requestTool) {
          chunk({ tool_calls: [{ index: 0, id: "call_progress", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "printf tool-progress-marker", description: "progress test" }) } }] })
          chunk({}, "tool_calls")
        } else {
          chunk({ content: "raw canonical answer" })
          chunk({}, "stop")
        }
        controller.enqueue(enc.encode("data: [DONE]\n\n"))
        controller.close()
      },
    }), { headers: { "Content-Type": "text/event-stream" } })
  },
})

writeFileSync(join(root, "settings.json"), JSON.stringify({
  serverToken: token,
  provider: "faux",
  selections: { faux: { model: "faux-model" } },
  customProviders: [{ id: "faux", label: "Faux", baseURL: `http://127.0.0.1:${provider.port}/v1`, billing: "metered", defaultModel: "faux-model" }],
}))
writeFileSync(join(root, "auth.json"), JSON.stringify({ faux: { type: "api", key: "faux-key" } }))
const proc = Bun.spawn([process.execPath, "run", "packages/server/src/index.ts"], {
  cwd: join(import.meta.dir, "../../.."),
  env: {
    ...process.env,
    CHUNKY_PORT: String(port), CHUNKY_SETTINGS: join(root, "settings.json"), CHUNKY_AUTH: join(root, "auth.json"),
    CHUNKY_DB: dbPath, CHUNKY_GRAPH_DB: join(root, "graph.db"), CHUNKY_RELAY: "0", CHUNKY_WORKSPACE: root,
  },
  stdout: "ignore", stderr: "ignore",
})
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
  for (const event of events) insert.run(id, (next.get(id) as { n: number }).n, JSON.stringify(event))
}

async function openV2(id: string, cursor?: SessionEventCursor, headers: Record<string, string> = {}) {
  const query = cursor ? `&cursor=${encodeURIComponent(encodeSessionEventCursor(cursor))}` : ""
  const abort = new AbortController()
  const response = await request(`/api/sessions/${id}/events?stream=v2${query}`, { headers: { ...auth, ...headers }, signal: abort.signal })
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
  await request("/api/info", { headers: auth })
  db = new Database(dbPath)
})
afterAll(async () => {
  db?.close()
  try { proc.kill("SIGTERM") } catch {}
  await proc.exited
  provider.stop(true)
  rmSync(root, { recursive: true, force: true })
})

describe("cursor-aware session event streams", () => {
  test("empty session immediately sends replay-end at zero then live ports", async () => {
    const id = await createSession()
    const stream = await openV2(id)
    const frames = await initial(stream, 2)
    expect(frames[0]).toEqual({ kind: "replay-end", cursor: { generation: generation(id), nextSeq: 0 } })
    expect(frames[1]).toMatchObject({ kind: "live", event: { type: "ports.changed" } })
  })

  test("first replay assigns sequences and its captured boundary", async () => {
    const id = await createSession()
    append(id, [{ type: "message.user", text: "zero" }, { type: "message.delta", text: "one" }, { type: "message.end" }])
    const frames = await initial(await openV2(id), 5)
    expect(frames.slice(0, 3).map((frame: any) => [frame.kind, frame.seq, frame.cursor.nextSeq])).toEqual([["event", 0, 1], ["event", 1, 2], ["event", 2, 3]])
    expect(frames[3]).toEqual({ kind: "replay-end", cursor: { generation: generation(id), nextSeq: 3 } })
  })

  test("suffix resume sends only rows at and after the cursor", async () => {
    const id = await createSession(); append(id, [0, 1, 2].map((n) => ({ type: "message.delta", text: String(n) } as AgentEvent)))
    const frames = await initial(await openV2(id, { generation: generation(id), nextSeq: 2 }), 3)
    expect(frames[0]).toMatchObject({ kind: "event", seq: 2 })
    expect(frames[1]).toMatchObject({ kind: "replay-end", cursor: { nextSeq: 3 } })
  })

  test("cursor at boundary sends replay-end then live with no replay events and accepts Last-Event-ID", async () => {
    const id = await createSession(); append(id, [{ type: "message.user", text: "done" }])
    const cursor = { generation: generation(id), nextSeq: 1 }
    const stream = await openV2(id, undefined, { "Last-Event-ID": encodeSessionEventCursor(cursor) })
    const frames = await initial(stream, 2)
    expect(frames.map((frame) => frame.kind)).toEqual(["replay-end", "live"])
  })

  test("cursor ahead resets and replays from zero", async () => {
    const id = await createSession(); append(id, [{ type: "message.user", text: "zero" }])
    const frames = await initial(await openV2(id, { generation: generation(id), nextSeq: 9 }), 4)
    expect(frames[0]).toMatchObject({ kind: "replay-reset", reason: "cursor-ahead", cursor: { nextSeq: 0 } })
    expect(frames[1]).toMatchObject({ kind: "event", seq: 0 })
  })

  test("rewritten history resets even after sequence space regrows past the old cursor", async () => {
    const id = await createSession(); append(id, ["a", "b", "c"].map((text) => ({ type: "message.delta", text })))
    const old = { generation: generation(id), nextSeq: 2 }
    db.transaction(() => {
      db.query("DELETE FROM events WHERE session_id=? AND seq>=1").run(id)
      db.query("UPDATE sessions SET history_generation=? WHERE id=?").run(crypto.randomUUID(), id)
      append(id, ["new-b", "new-c", "new-d"].map((text) => ({ type: "message.delta", text })))
    })()
    const frames = await initial(await openV2(id, old), 6)
    expect(frames[0]).toMatchObject({ kind: "replay-reset", reason: "history-rewritten", cursor: { nextSeq: 0 } })
    expect(frames.slice(1, 5).map((frame: any) => frame.seq)).toEqual([0, 1, 2, 3])
  })

  test("raw deltas are live and a canonical persisted delta follows as an event", async () => {
    const id = await createSession()
    const stream = await openV2(id)
    await stream.next(); await stream.next() // replay-end, initial ports
    const sent = await request(`/api/sessions/${id}/messages`, { method: "POST", headers: auth, body: JSON.stringify({ text: "answer briefly" }) })
    expect(sent.status).toBe(202)
    const seen: ParsedFrame[] = []
    for (let i = 0; i < 30; i++) {
      const frame = await stream.next(); seen.push(frame)
      if (frame.kind === "event" && frame.event.type === "message.delta" && frame.event.text.includes("raw canonical answer")) break
    }
    stream.abort.abort()
    expect(seen.some((frame) => frame.kind === "live" && frame.event.type === "message.delta" && frame.event.text.includes("raw canonical answer"))).toBe(true)
    const canonical = seen.find((frame) => frame.kind === "event" && frame.event.type === "message.delta") as Extract<SessionEventStreamFrame, { kind: "event" }>
    expect(canonical.seq).toBeNumber()
    expect(canonical.cursor.nextSeq).toBe(canonical.seq + 1)
  }, 30_000)

  test("tool.progress is live and carries no cursor", async () => {
    const id = await createSession()
    const stream = await openV2(id)
    await stream.next(); await stream.next()
    const sent = await request(`/api/sessions/${id}/messages`, { method: "POST", headers: auth, body: JSON.stringify({ text: "produce tool progress" }) })
    expect(sent.status).toBe(202)
    let progress: ParsedFrame | undefined
    for (let i = 0; i < 30; i++) {
      const frame = await stream.next()
      if (frame.kind === "live" && frame.event.type === "tool.progress") { progress = frame; break }
    }
    stream.abort.abort()
    expect(progress).toMatchObject({ kind: "live", event: { type: "tool.progress", chunk: expect.stringContaining("tool-progress-marker") } })
    expect("cursor" in progress!).toBe(false)
  }, 30_000)

  test("ports.changed is live and carries no cursor", async () => {
    const id = await createSession()
    const frames = await initial(await openV2(id), 2)
    expect(frames[1]).toMatchObject({ kind: "live", event: { type: "ports.changed" } })
    expect("cursor" in frames[1]!).toBe(false)
  })

  test("legacy request keeps unnamed data frames and no named control frames", async () => {
    const id = await createSession(); append(id, [{ type: "message.user", text: "legacy" }])
    const abort = new AbortController()
    const response = await request(`/api/sessions/${id}/events`, { headers: auth, signal: abort.signal })
    const reader = response.body!.getReader()
    let text = ""
    while (!text.includes('"ports.changed"')) text += new TextDecoder().decode((await reader.read()).value)
    abort.abort()
    expect(text.startsWith(": ready\n\n")).toBe(true)
    expect(text).toContain(`data: ${JSON.stringify({ type: "message.user", text: "legacy" })}\n\n`)
    expect(text).not.toContain("event:")
  })

  test("malformed cursor returns 400 JSON", async () => {
    const id = await createSession()
    const response = await request(`/api/sessions/${id}/events?stream=v2&cursor=not!base64`, { headers: auth })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: "invalid session event cursor" })
  })
})
