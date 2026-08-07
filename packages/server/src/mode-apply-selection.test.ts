import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { AgentEvent } from "@chunky/protocol"

const root = mkdtempSync(join(tmpdir(), "chunky-mode-apply-"))
const token = "mode-apply-token"
const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } })
const port = probe.port
probe.stop()
writeFileSync(join(root, "settings.json"), JSON.stringify({
  serverToken: token,
  provider: "grok",
  selections: { grok: { model: "grok-4.5", effort: "high" } },
  advisor: { enabled: false }, review: { enabled: false }, sidekick: { enabled: false }, sidekickSeats: {},
}))
const proc = Bun.spawn([process.execPath, "run", "packages/server/src/index.ts"], {
  cwd: join(import.meta.dir, "../../.."),
  env: { ...process.env, CHUNKY_PORT: String(port), CHUNKY_SETTINGS: join(root, "settings.json"), CHUNKY_DB: join(root, "chunky.db"), CHUNKY_RELAY: "0" },
  stdout: "ignore", stderr: "ignore",
})
const base = `http://127.0.0.1:${port}`
const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  for (let i = 0; i < 80; i++) {
    try { return await fetch(base + path, { ...init, headers: { ...headers, ...(init.headers ?? {}) } }) }
    catch { await Bun.sleep(25) }
  }
  throw new Error("server did not start")
}
async function json(path: string, init: RequestInit = {}) { return await (await request(path, init)).json() as any }
async function createSession(): Promise<string> { return (await json("/api/sessions", { method: "POST", body: JSON.stringify({ cwd: root }) })).sessionId }
async function openEvents(sessionId: string) {
  const response = await request(`/api/sessions/${sessionId}/events`)
  const reader = response.body!.getReader(), decoder = new TextDecoder()
  let buffer = ""
  return {
    async next(timeoutMs = 1_000): Promise<AgentEvent | null> {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const result = await Promise.race([reader.read(), Bun.sleep(deadline - Date.now()).then(() => null)])
        if (!result || result.done) return null
        buffer += decoder.decode(result.value, { stream: true })
        const frames = buffer.split("\n\n"); buffer = frames.pop() ?? ""
        for (const frame of frames) {
          const data = frame.split("\n").find((line) => line.startsWith("data: "))
          if (data) return JSON.parse(data.slice(6)) as AgentEvent
        }
      }
      return null
    },
    close() { void reader.cancel() },
  }
}

const completeSpec = {
  provider: "zen", model: "glm-5.2", effort: "low", speed: "fast",
  advisor: { provider: "grok", model: "grok-4.5", effort: "high" },
  review: { provider: "codex", model: "gpt-5.6-sol", effort: "medium" },
  sidekick: { provider: "codex", model: "gpt-5.6-luna", effort: "xhigh" },
  sidekickSeats: { frontend: { provider: "anthropic", model: "claude-opus-4-6", effort: "high" } },
}

afterAll(async () => { proc.kill("SIGTERM"); await proc.exited; rmSync(root, { recursive: true, force: true }) })

describe("mode apply selection", () => {
  test("session apply persists the complete preset without changing globals", async () => {
    await json("/api/modes", { method: "POST", body: JSON.stringify({ name: "session-complete", spec: completeSpec }) })
    const sessionId = await createSession(), globalBefore = await json("/api/model")
    expect(await json("/api/modes/session-complete/apply", { method: "POST", body: JSON.stringify({ sessionId }) })).toMatchObject({ applied: "session-complete", provider: "zen", model: "glm-5.2" })
    expect(await json("/api/model")).toEqual(globalBefore)
    expect(await json(`/api/model?sessionId=${sessionId}`)).toMatchObject({ provider: "zen", model: "glm-5.2", effort: "low", speed: "fast", solo: false, pinned: true })
    expect(await json(`/api/sessions/${sessionId}/agent-config`)).toEqual({
      selection: { provider: "zen", model: "glm-5.2", effort: "low", speed: "fast", solo: false }, source: "session-mode", activeMode: "session-complete",
      advisor: { enabled: true, ...completeSpec.advisor }, review: { enabled: true, ...completeSpec.review },
      sidekick: { enabled: true, ...completeSpec.sidekick }, sidekickSeats: completeSpec.sidekickSeats,
    })
  })

  test("global apply changes defaults but cannot change a mode-pinned session", async () => {
    await json("/api/modes", { method: "POST", body: JSON.stringify({ name: "new-global", spec: { provider: "grok", model: "global-after", effort: "medium", advisor: null, review: null, sidekick: null, sidekickSeats: null } }) })
    const sessionId = await createSession()
    await json("/api/modes/session-complete/apply", { method: "POST", body: JSON.stringify({ sessionId }) })
    expect((await request("/api/modes/new-global/apply", { method: "POST" })).status).toBe(200)
    expect(await json("/api/model")).toMatchObject({ provider: "grok", model: "global-after", effort: "medium" })
    expect(await json(`/api/model?sessionId=${sessionId}`)).toMatchObject({ provider: "zen", model: "glm-5.2", pinned: true })
    expect(await json(`/api/sessions/${sessionId}/agent-config`)).toMatchObject({ source: "session-mode", activeMode: "session-complete", advisor: { enabled: true, model: "grok-4.5" }, review: { enabled: true, model: "gpt-5.6-sol" }, sidekick: { enabled: true, model: "gpt-5.6-luna" }, sidekickSeats: { frontend: { model: "claude-opus-4-6" } } })
  })

  test("model reads report pin provenance for inherited, raw, and mode selections", async () => {
    const id = await createSession()
    expect(await json(`/api/model?sessionId=${id}`)).toMatchObject({ pinned: false })
    expect(await json(`/api/sessions/${id}/agent-config`)).toMatchObject({ source: "global", activeMode: null })
    await json("/api/model/select", { method: "POST", body: JSON.stringify({ sessionId: id, provider: "grok", model: "raw-pin" }) })
    expect(await json(`/api/model?sessionId=${id}`)).toMatchObject({ model: "raw-pin", pinned: true })
    expect(await json(`/api/sessions/${id}/agent-config`)).toMatchObject({ source: "session-selection", activeMode: null })
    await json("/api/modes/session-complete/apply", { method: "POST", body: JSON.stringify({ sessionId: id }) })
    expect(await json(`/api/sessions/${id}/agent-config`)).toMatchObject({ source: "session-mode", activeMode: "session-complete" })
    const unknown = await request("/api/modes/session-complete/apply", { method: "POST", body: JSON.stringify({ sessionId: "unknown-session" }) })
    expect(unknown.status).toBe(404); expect(await unknown.json()).toEqual({ error: "unknown session" })
  })

  test("session mode events reach only that session; global mode events broadcast", async () => {
    const target = await createSession(), other = await createSession()
    const targetEvents = await openEvents(target), otherEvents = await openEvents(other)
    await json("/api/modes/session-complete/apply", { method: "POST", body: JSON.stringify({ sessionId: target }) })
    expect(await targetEvents.next()).toMatchObject({ type: "mode.applied", name: "session-complete", sessionId: target })
    expect(await otherEvents.next(150)).toBeNull()
    // The timed read remains pending by design; cancel and reattach before the
    // broadcast assertion so there is never more than one reader.read in flight.
    otherEvents.close()
    const otherBroadcastEvents = await openEvents(other)
    await json("/api/modes/new-global/apply", { method: "POST" })
    expect(await targetEvents.next()).toMatchObject({ type: "mode.applied", name: "new-global" })
    expect(await otherBroadcastEvents.next()).toMatchObject({ type: "mode.applied", name: "new-global" })
    targetEvents.close(); otherBroadcastEvents.close()
  })
})
