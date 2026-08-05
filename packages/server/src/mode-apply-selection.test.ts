import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

const root = mkdtempSync(join(tmpdir(), "chunky-mode-apply-"))
const token = "mode-apply-token"
const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } })
const port = probe.port
probe.stop()
writeFileSync(join(root, "settings.json"), JSON.stringify({ serverToken: token }))
const proc = Bun.spawn([process.execPath, "run", "packages/server/src/index.ts"], {
  cwd: join(import.meta.dir, "../../.."),
  env: {
    ...process.env,
    CHUNKY_PORT: String(port),
    CHUNKY_SETTINGS: join(root, "settings.json"),
    CHUNKY_DB: join(root, "chunky.db"),
    CHUNKY_RELAY: "0",
  },
  stdout: "ignore",
  stderr: "ignore",
})
const base = `http://127.0.0.1:${port}`
const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  for (let i = 0; i < 80; i++) {
    try {
      return await fetch(base + path, { ...init, headers: { ...headers, ...(init.headers ?? {}) } })
    } catch {
      await Bun.sleep(25)
    }
  }
  throw new Error("server did not start")
}

async function json(path: string, init: RequestInit = {}) {
  return await (await request(path, init)).json() as any
}

afterAll(async () => {
  proc.kill("SIGTERM")
  await proc.exited
  rmSync(root, { recursive: true, force: true })
})

describe("mode apply selection", () => {
  test("session-scoped apply clears a pin, no-body apply still works, and unknown sessions fail", async () => {
    await json("/api/modes", {
      method: "POST",
      body: JSON.stringify({
        name: "mode-apply-zen",
        spec: { provider: "zen", model: "glm-5.2", effort: "low" },
      }),
    })

    const created = await json("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ cwd: root }),
    })
    const sessionId = created.sessionId as string
    await json("/api/model/select", {
      method: "POST",
      body: JSON.stringify({ sessionId, provider: "grok", model: "grok-4.5", effort: "high" }),
    })
    expect(await json(`/api/model?sessionId=${encodeURIComponent(sessionId)}`)).toMatchObject({
      provider: "grok",
      model: "grok-4.5",
      effort: "high",
      solo: true,
    })

    await json("/api/modes/mode-apply-zen/apply", {
      method: "POST",
      body: JSON.stringify({ sessionId }),
    })
    // The scoped model endpoint reads effectiveSessionSelection(sessionId).
    // solo:false proves the prior session pin was cleared rather than replaced.
    expect(await json(`/api/model?sessionId=${encodeURIComponent(sessionId)}`)).toMatchObject({
      provider: "zen",
      model: "glm-5.2",
      effort: "low",
      solo: false,
    })

    const noBody = await request("/api/modes/mode-apply-zen/apply", { method: "POST" })
    expect(noBody.status).toBe(200)
    expect(await noBody.json()).toMatchObject({
      applied: "mode-apply-zen",
      provider: "zen",
      model: "glm-5.2",
      effort: "low",
    })

    const unknown = await request("/api/modes/mode-apply-zen/apply", {
      method: "POST",
      body: JSON.stringify({ sessionId: "unknown-session" }),
    })
    expect(unknown.status).toBe(404)
    expect(await unknown.json()).toEqual({ error: "unknown session" })
  })
})
