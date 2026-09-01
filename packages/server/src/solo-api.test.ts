import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { reserveIntegrationServer } from "./test-server.ts"

const root = mkdtempSync(join(tmpdir(), "chunky-solo-api-"))
const token = "solo-api-token"
const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } })
const port = probe.port
probe.stop()
writeFileSync(join(root, "settings.json"), JSON.stringify({ serverToken: token }))
const server = reserveIntegrationServer({ prefix: "chunky-solo-api-", root, port, env: { ...process.env, CHUNKY_PORT: String(port), CHUNKY_SETTINGS: join(root, "settings.json"), CHUNKY_DB: join(root, "chunky.db"), CHUNKY_RELAY: "0" } })
let proc: Bun.Subprocess
const base = `http://127.0.0.1:${port}`
const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
async function request(path: string, init: RequestInit = {}): Promise<Response> {
  for (let i = 0; i < 80; i++) { try { return await fetch(base + path, init) } catch { await Bun.sleep(25) } }
  throw new Error("server did not start")
}
async function json(path: string, init: RequestInit = {}) { return await (await request(path, { ...init, headers: { ...headers, ...(init.headers ?? {}) } })).json() as any }
beforeAll(async () => { proc = await server.start() })
afterAll(async () => { await server.stop() })

describe("solo model HTTP routes", () => {
  test("raw selection sets solo, explicit delegate config exits solo, and mode apply restores it", async () => {
    await json("/api/advisor", { method: "POST", body: JSON.stringify({ enabled: true, provider: "codex", model: "gpt-5.5" }) })
    await json("/api/sidekick", { method: "POST", body: JSON.stringify({ enabled: true, provider: "codex", model: "gpt-5.5" }) })
    await json("/api/review", { method: "POST", body: JSON.stringify({ enabled: true, provider: "codex", model: "gpt-5.5" }) })
    const selected = await json("/api/model/select", { method: "POST", body: JSON.stringify({ provider: "zen", model: "glm-5.2" }) })
    expect(selected.solo).toBe(true)
    expect((await json("/api/model")).solo).toBe(true)
    expect((await json("/api/sidekick")).config.enabled).toBe(false) // effective response is gated
    expect((await json("/api/review")).active).toBe(false)
    expect((await json("/api/advisor")).active).toBe(false)

    const exited = await json("/api/advisor", { method: "POST", body: JSON.stringify({ enabled: true }) })
    expect(exited.active).toBe(true)
    expect((await json("/api/model")).solo).toBe(false)

    await json("/api/model/select", { method: "POST", body: JSON.stringify({ provider: "zen", model: "glm-5.2" }) })
    expect((await json("/api/model")).solo).toBe(true)
    await json("/api/sidekick", { method: "POST", body: JSON.stringify({ enabled: true }) })
    expect((await json("/api/model")).solo).toBe(false)

    await json("/api/modes", { method: "POST", body: JSON.stringify({ name: "solo-api-mode", spec: { provider: "zen", model: "glm-5.2", advisor: { provider: "codex", model: "gpt-5.5" }, sidekick: { provider: "codex", model: "gpt-5.5" } } }) })
    await json("/api/model/select", { method: "POST", body: JSON.stringify({ provider: "zen", model: "glm-5.2" }) })
    expect((await json("/api/model")).solo).toBe(true)
    const applied = await json("/api/modes/solo-api-mode/apply", { method: "POST" })
    expect((await json("/api/model")).solo).toBe(false)
    expect(applied.advisorActive).toBe(true)
    expect(applied.sidekick.enabled).toBe(true)
  })

  test("solo advisor endpoint persists its independent opt-in", async () => {
    const body = await json("/api/solo-advisor", { method: "POST", body: JSON.stringify({ enabled: true, provider: "codex", model: "gpt-5.5" }) })
    expect(body.config).toMatchObject({ enabled: true, provider: "codex", model: "gpt-5.5" })
    const read = await json("/api/solo-advisor")
    expect(read.config).toMatchObject(body.config)
  })

  test("session-pinned model selection reports solo on select and session-scoped read", async () => {
    const created = await json("/api/sessions", { method: "POST", body: JSON.stringify({ cwd: root }) })
    const sessionId = created.sessionId as string
    expect(sessionId).toBeTruthy()

    const selected = await json("/api/model/select", {
      method: "POST",
      body: JSON.stringify({ sessionId, provider: "zen", model: "glm-5.2" }),
    })
    expect(selected).toMatchObject({ provider: "zen", model: "glm-5.2", solo: true })

    const scoped = await json(`/api/model?sessionId=${encodeURIComponent(sessionId)}`)
    expect(scoped).toMatchObject({ provider: "zen", model: "glm-5.2", solo: true })
  })

})
