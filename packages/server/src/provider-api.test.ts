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
writeFileSync(authPath, JSON.stringify({ "broken-custom": { type: "api", key: "bad-key" }, telnyx: { type: "api", key: "telnyx-test-key" } }))

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

  test("disabling a provider persists without deleting credentials and blocks catalog and selection", async () => {
    const path = "/api/providers/broken-custom/enabled"
    const disable = await request(path, { method: "PUT", headers, body: JSON.stringify({ enabled: false }) })
    expect(disable.status).toBe(200)
    expect(JSON.parse(readFileSync(settingsPath, "utf8")).disabledProviders).toContain("broken-custom")
    expect(JSON.parse(readFileSync(authPath, "utf8"))["broken-custom"].key).toBe("bad-key")
    const rows = await (await request("/api/providers", { method: "GET", headers })).json()
    expect(rows.providers.find((p: any) => p.id === "broken-custom")).toMatchObject({ enabled: false, ready: false })
    const models = await (await request("/api/providers/broken-custom/models", { method: "GET", headers })).json()
    expect(models).toEqual({ models: [] })
    const selected = await request("/api/model/select", { method: "POST", headers, body: JSON.stringify({ provider: "broken-custom", model: "any" }) })
    expect(selected.status).toBe(400)
    expect((await selected.json()).error).toContain("disabled")
    const enable = await request(path, { method: "PUT", headers, body: JSON.stringify({ enabled: true }) })
    expect(enable.status).toBe(200)
    expect(JSON.parse(readFileSync(settingsPath, "utf8")).disabledProviders).not.toContain("broken-custom")
  })

  test("remembered thread model survives a fresh session while existing pins stay isolated", async () => {
    const create = async () => (await (await request("/api/sessions", { method: "POST", headers, body: "{}" })).json()).sessionId as string
    const select = async (sessionId: string, model: string, remember?: boolean) => request("/api/model/select", {
      method: "POST", headers, body: JSON.stringify({ sessionId, provider: "telnyx", model, remember }),
    })
    const previous = await create()
    expect((await select(previous, "previous-model")).status).toBe(200)
    const current = await create()
    expect((await select(current, "chosen-model", true)).status).toBe(200)
    const saved = JSON.parse(readFileSync(settingsPath, "utf8"))
    expect(saved.provider).toBe("telnyx")
    expect(saved.selections.telnyx.model).toBe("chosen-model")
    expect(saved.activeMode).toBeUndefined()
    const fresh = await create() // /clear creates a new session the same way.
    for (const id of [current, fresh]) {
      const selected = await (await request(`/api/model?sessionId=${id}`, { method: "GET", headers })).json()
      expect(selected).toMatchObject({ provider: "telnyx", model: "chosen-model", solo: true })
    }
    expect(await (await request(`/api/model?sessionId=${previous}`, { method: "GET", headers })).json()).toMatchObject({ model: "previous-model" })
    expect((await select(previous, "private-to-thread", false)).status).toBe(200)
    expect(JSON.parse(readFileSync(settingsPath, "utf8")).selections.telnyx.model).toBe("chosen-model")
  })

  test("incognito selections never become normal defaults even when remember is requested", async () => {
    const before = readFileSync(settingsPath, "utf8")
    const createdMode = await request("/api/modes", { method: "POST", headers, body: JSON.stringify({ name: "private-choice", spec: { provider: "telnyx", model: "private-start", solo: true, incognito: { allow: ["telnyx"] } } }) })
    expect(createdMode.status).toBe(200)
    const applied = await request("/api/modes/private-choice/apply", { method: "POST", headers })
    expect(applied.status).toBe(200)
    const created = await (await request("/api/sessions", { method: "POST", headers, body: "{}" })).json()
    expect(created.incognito).toBe(true)
    const normalBefore = readFileSync(settingsPath, "utf8")
    const selected = await request("/api/model/select", { method: "POST", headers, body: JSON.stringify({ sessionId: created.sessionId, provider: "telnyx", model: "private-new", remember: true }) })
    expect(selected.status).toBe(200)
    expect((await selected.json()).model).toBe("private-new")
    expect(readFileSync(settingsPath, "utf8")).toBe(normalBefore)
    // Restore the normal default through the public route.
    const saved = JSON.parse(before)
    await request("/api/model/select", { method: "POST", headers, body: JSON.stringify({ provider: saved.provider, ...saved.selections[saved.provider] }) })
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
