import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ROUTES } from "@chunky/protocol"
import { reserveIntegrationServer } from "./test-server.ts"

const root = mkdtempSync(join(tmpdir(), "chunky-provider-api-"))
const token = "provider-api-test-token"
const provider = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () => new Response("denied", { status: 401 }),
})
const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } })
const port = listener.port
listener.stop()
const settingsPath = join(root, "settings.json")
const authPath = join(root, "auth.json")
writeFileSync(settingsPath, JSON.stringify({
  serverToken: token,
  customProviders: [{ id: "broken-custom", label: "Broken Custom", baseURL: `http://127.0.0.1:${provider.port}/v1` }],
}))
writeFileSync(authPath, JSON.stringify({ "broken-custom": { type: "api", key: "bad-key" } }))

const server = reserveIntegrationServer({ prefix: "chunky-provider-api-", root, port, env: { ...process.env, CHUNKY_PORT: String(port), CHUNKY_SETTINGS: settingsPath, CHUNKY_AUTH: authPath, CHUNKY_DB: join(root, "chunky.db"), CHUNKY_RELAY: "0" } })
const baseUrl = `http://127.0.0.1:${port}`
const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }

async function request(path: string, init: RequestInit): Promise<Response> {
  let last: unknown
  for (let attempt = 0; attempt < 80; attempt++) {
    try { return await fetch(baseUrl + path, init) }
    catch (error) { last = error; await Bun.sleep(25) }
  }
  throw last
}

beforeAll(async () => { await server.start() })
afterAll(async () => {
  await server.stop()
  provider.stop(true)
})

describe("provider setup API", () => {
  test("provider key route stores a key without echoing it", async () => {
    const response = await request(ROUTES.providerKey("route-provider"), {
      method: "POST", headers, body: JSON.stringify({ key: "route-secret" }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(JSON.parse(readFileSync(authPath, "utf8"))["route-provider"]).toEqual({ type: "api", key: "route-secret" })
  })

  test("Go key setup stores credentials under its own provider without echoing them", async () => {
    const response = await request(ROUTES.providerKey("opencode-go"), {
      method: "POST", headers, body: JSON.stringify({ key: "go-route-secret" }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    const auth = JSON.parse(readFileSync(authPath, "utf8"))
    expect(auth["opencode-go"]).toEqual({ type: "api", key: "go-route-secret" })
    expect(auth["zen"]).toBeUndefined()
  })

  test("custom-provider auth test reports authenticated models endpoint failure", async () => {
    const response = await request(ROUTES.authTest("broken-custom"), { method: "POST", headers })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: false, error: "Broken Custom models endpoint returned 401" })
  })

  test("provider rows and auth status carry verified sign-in state", async () => {
    const list = await request("/api/providers", { method: "GET", headers })
    expect(list.status).toBe(200)
    const { providers } = await list.json() as { providers: Array<{ id: string; ready: boolean; auth: { state: string; canLogin: boolean; detail?: string; checkedAt?: number } }> }
    const custom = providers.find((row) => row.id === "broken-custom")
    expect(custom).toMatchObject({ ready: true, auth: { state: "ok", canLogin: false } })
    const anthropic = providers.find((row) => row.id === "anthropic")
    expect(anthropic?.auth.canLogin).toBe(true)
    expect(["ok", "expired", "missing", "unknown"]).toContain(anthropic?.auth.state ?? "absent")

    const status = await request(ROUTES.authStatus("broken-custom"), { method: "GET", headers })
    expect(status.status).toBe(200)
    expect(await status.json()).toEqual({ ready: true, auth: { state: "ok", canLogin: false } })

    // Anthropic status is the cached verified view: no probe runs here.
    const claude = await request(ROUTES.authStatus("anthropic"), { method: "GET", headers })
    expect(claude.status).toBe(200)
    const claudeStatus = await claude.json() as { ready: boolean; auth: { state: string; canLogin: boolean } }
    expect(typeof claudeStatus.ready).toBe("boolean")
    expect(claudeStatus.auth.canLogin).toBe(true)
    expect(claudeStatus.ready).toBe(claudeStatus.auth.state === "ok")

    const unknown = await request(ROUTES.authStatus("nope"), { method: "GET", headers })
    expect(unknown.status).toBe(404)
  })

  test("logout removes stored credentials and reports missing", async () => {
    const stored = await request(ROUTES.providerKey("logout-provider"), { method: "POST", headers, body: JSON.stringify({ key: "logout-secret" }) })
    expect(stored.status).toBe(200)
    const logout = await request(ROUTES.authLogout("broken-custom"), { method: "POST", headers })
    expect(logout.status).toBe(200)
    expect(await logout.json()).toEqual({ ok: true })
    expect(JSON.parse(readFileSync(authPath, "utf8"))["broken-custom"]).toBeUndefined()
    const status = await request(ROUTES.authStatus("broken-custom"), { method: "GET", headers })
    expect(await status.json()).toEqual({ ready: false, auth: { state: "missing", canLogin: false } })
    const test = await request(ROUTES.authTest("broken-custom"), { method: "POST", headers })
    expect(await test.json()).toEqual({ ok: false, error: "Missing API key for broken-custom" })
  })
})
