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

  test("custom-provider auth test reports authenticated models endpoint failure", async () => {
    const response = await request(ROUTES.authTest("broken-custom"), { method: "POST", headers })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: false, error: "Broken Custom models endpoint returned 401" })
  })
})
