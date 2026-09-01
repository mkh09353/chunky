import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { reserveIntegrationServer } from "./test-server.ts"

const root = mkdtempSync(join(tmpdir(), "chunky-cors-"))
const token = "cors-test-token"
const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() { return undefined } } })
const port = listener.port
listener.stop()

writeFileSync(join(root, "settings.json"), JSON.stringify({ serverToken: token }))
const server = reserveIntegrationServer({ prefix: "chunky-cors-", root, port, env: {
    ...process.env,
    CHUNKY_PORT: String(port),
    CHUNKY_SETTINGS: join(root, "settings.json"),
    CHUNKY_DB: join(root, "chunky.db"),
    CHUNKY_RELAY: "0",
  } })
let proc: Bun.Subprocess
const baseUrl = `http://127.0.0.1:${port}`
const allowedOrigin = "views://mainview"
const auth = { Authorization: `Bearer ${token}` }

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

function expectAllowedCors(response: Response): void {
  expect(response.headers.get("Access-Control-Allow-Origin")).toBe(allowedOrigin)
  expect(response.headers.get("Vary")).toContain("Origin")
}

beforeAll(async () => { proc = await server.start() })
afterAll(async () => { await server.stop() })

describe("server CORS responses", () => {
  test("adds CORS headers to authenticated JSON responses, including routes that do not pass req to json", async () => {
    const info = await request("/api/info", { headers: { ...auth, Origin: allowedOrigin } })
    expect(info.status).toBe(200)
    expectAllowedCors(info)

    const repos = await request("/api/repos", { headers: { ...auth, Origin: allowedOrigin } })
    expect(repos.status).toBe(200)
    expectAllowedCors(repos)
  })

  test("returns a session's pinned selection from GET /api/model?sessionId", async () => {
    const created = await request("/api/sessions", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: "{}",
    })
    expect(created.status).toBe(200)
    const { sessionId } = await created.json() as { sessionId: string }

    const selected = await request("/api/model/select", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, provider: "zen", model: "session-pinned-model", effort: "high", speed: "fast" }),
    })
    expect(selected.status).toBe(200)

    const response = await request(`/api/model?sessionId=${encodeURIComponent(sessionId)}`, { headers: auth })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      provider: "zen",
      model: "session-pinned-model",
      effort: "high",
      speed: "fast",
      solo: true,
      pinned: true,
    })
  })

  test("preserves strict origin policy while allowing non-browser clients", async () => {
    const rejected = await request("/api/info", { headers: { ...auth, Origin: "null" } })
    expect(rejected.status).toBe(403)
    expect(rejected.headers.get("Access-Control-Allow-Origin")).toBeNull()
    expect(rejected.headers.get("Vary")).toBeNull()

    const noOrigin = await request("/api/info", { headers: auth })
    expect(noOrigin.status).toBe(200)
    expect(noOrigin.headers.get("Access-Control-Allow-Origin")).toBeNull()
  })

  test("includes CORS headers on preflight, not-found, and SSE responses", async () => {
    const options = await request("/api/info", {
      method: "OPTIONS",
      headers: {
        Origin: allowedOrigin,
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "authorization",
      },
    })
    expect(options.status).toBe(204)
    expectAllowedCors(options)
    expect(options.headers.get("Access-Control-Allow-Headers")).toContain("Last-Event-ID")

    const notFound = await request("/api/not-a-route", { headers: { ...auth, Origin: allowedOrigin } })
    expect(notFound.status).toBe(404)
    expectAllowedCors(notFound)

    const created = await request("/api/sessions", { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: "{}" })
    expect(created.status).toBe(200)
    const { sessionId } = await created.json() as { sessionId: string }
    const controller = new AbortController()
    const streamPromise = request(`/api/sessions/${sessionId}/events`, {
      headers: { ...auth, Origin: allowedOrigin }, signal: controller.signal,
    })
    await Bun.sleep(20)
    const sent = await request(`/api/sessions/${sessionId}/messages`, {
      method: "POST", headers: { ...auth, Origin: allowedOrigin, "Content-Type": "application/json" }, body: '{"text":"CORS stream test"}',
    })
    expect(sent.status).toBe(202)
    expectAllowedCors(sent)
    const stream = await streamPromise
    expect(stream.status).toBe(200)
    expect(stream.headers.get("Content-Type")).toContain("text/event-stream")
    expectAllowedCors(stream)
    controller.abort()
  })
})
