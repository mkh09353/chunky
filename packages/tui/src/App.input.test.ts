import { expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Session } from "../../termctrl/src/session.js"

test("provider setup owns keyboard input and returns it to the prompt on close", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "chunky-onboarding-input-"))
  const settings = join(cwd, "settings.json")
  writeFileSync(settings, JSON.stringify({ theme: "dark" }))
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname
      if (path === "/api/onboarding") return Response.json({ providers: [
        { id: "claude", label: "Claude", status: "inherited" },
        { id: "codex", label: "Codex", status: "missing" },
      ] })
      if (path === "/api/sessions" && req.method === "POST") return Response.json({ sessionId: "test" })
      if (path.endsWith("/events")) return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode(": ready\n\n")) },
      }), { headers: { "content-type": "text/event-stream" } })
      return Response.json({ workspace: cwd })
    },
  })
  const session = new Session([process.execPath, "run", join(import.meta.dir, "index.tsx"), "--live"], {
    cwd, cols: 100, rows: 36,
    env: { CHUNKY_PORT: String(server.port), CHUNKY_SETTINGS: settings, CHUNKY_HOME: cwd },
  })
  async function send(text: string) {
    session.send(new TextEncoder().encode(text))
    await Bun.sleep(100)
  }
  try {
    await session.waitForText("connect a provider")
    await send("\x1b[B")
    expect(session.text()).toContain("❯ ✗ Codex")
    await send("c")
    await session.waitForText("Custom OpenAI-compatible provider")
    await send("test-provider")
    expect(session.text()).toContain("id: test-provider")
    // The wizard and composer are both mounted: only the wizard may edit text.
    expect(session.text()).toContain('Try "fix lint errors"')
    for (const value of ["Test label", "https://example.invalid", "test-secret"]) {
      await send("\r")
      await send(value)
    }
    expect(session.text()).toContain("API key: •••••••••••")
    expect(session.text()).not.toContain("test-secret")
    await send("\x1b")
    await send("hello after setup")
    expect(session.text()).not.toContain("Custom OpenAI-compatible provider")
    expect(session.text()).toContain("❯ hello after setup")
  } finally {
    session.stop()
    await session.process.exited
    server.stop(true)
    rmSync(cwd, { recursive: true, force: true })
  }
}, 15_000)

test("provider settings own input, persist disable, and the model picker excludes unconnected providers", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "chunky-provider-settings-"))
  const settings = join(cwd, "settings.json")
  writeFileSync(settings, JSON.stringify({ theme: "dark" }))
  let enabled = true
  const catalogs: string[] = []
  const server = Bun.serve({ port: 0, async fetch(req) {
    const path = new URL(req.url).pathname
    if (path === "/api/onboarding") return Response.json({ onboardedAt: 1 })
    if (path === "/api/providers") return Response.json({ providers: [
      { id: "codex", label: "Codex", enabled, ready: enabled },
      { id: "grok", label: "Grok", enabled: true, ready: false },
    ] })
    if (path === "/api/providers/codex/enabled") { enabled = (await req.json()).enabled; return Response.json({ enabled }) }
    if (path.endsWith("/models")) { catalogs.push(path); return Response.json({ models: [{ id: "test", name: "Test", reasoning: false }] }) }
    if (path === "/api/sessions" && req.method === "POST") return Response.json({ sessionId: "test" })
    if (path.endsWith("/events")) return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(": ready\n\n")) } }), { headers: { "content-type": "text/event-stream" } })
    return Response.json({ workspace: cwd })
  } })
  const session = new Session([process.execPath, "run", join(import.meta.dir, "index.tsx"), "--live"], {
    cwd, cols: 110, rows: 36, env: { CHUNKY_PORT: String(server.port), CHUNKY_SETTINGS: settings, CHUNKY_HOME: cwd },
  })
  async function send(text: string) { session.send(new TextEncoder().encode(text)); await Bun.sleep(100) }
  try {
    await session.waitForText('Try "fix lint errors"')
    await send("/settings"); await send("\r")
    await session.waitForText("Provider settings")
    await send(" ")
    await session.waitForText("[disabled]")
    expect(enabled).toBe(false)
    expect(session.text()).toContain('Try "fix lint errors"')
    await send("\x1b")
    await send("/model"); await send("\r")
    await session.waitForText("No models available")
    expect(catalogs).toEqual([])
    expect(session.text()).not.toContain("[login needed]")
  } finally { session.stop(); await session.process.exited; server.stop(true); rmSync(cwd, { recursive: true, force: true }) }
}, 15_000)

test("welcome model follows the attached session on startup and after clear", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "chunky-clear-model-"))
  const settings = join(cwd, "settings.json")
  writeFileSync(settings, JSON.stringify({ theme: "dark" }))
  let created = 0
  const queries: string[] = []
  const server = Bun.serve({ port: 0, fetch(req) {
    const url = new URL(req.url), path = url.pathname
    if (path === "/api/onboarding") return Response.json({ onboardedAt: 1 })
    if (path === "/api/sessions" && req.method === "POST") return Response.json({ sessionId: `thread-${++created}` })
    if (path === "/api/model") {
      const id = url.searchParams.get("sessionId")
      queries.push(id ?? "global")
      return Response.json({ provider: "telnyx", model: id === "thread-1" ? "session-one" : id === "thread-2" ? "session-two" : null })
    }
    if (path.endsWith("/events")) return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(": ready\n\n")) } }), { headers: { "content-type": "text/event-stream" } })
    return Response.json({ workspace: cwd })
  } })
  const session = new Session([process.execPath, "run", join(import.meta.dir, "index.tsx"), "--live"], {
    cwd, cols: 110, rows: 36, env: { CHUNKY_PORT: String(server.port), CHUNKY_SETTINGS: settings, CHUNKY_HOME: cwd },
  })
  async function send(text: string) { session.send(new TextEncoder().encode(text)); await Bun.sleep(100) }
  try {
    await session.waitForText("Session One")
    await send("/clear"); await send("\r")
    await session.waitForText("Session Two")
    expect(queries).toEqual(["thread-1", "thread-2"])
    expect(session.text()).not.toContain("Session One")
  } finally { session.stop(); await session.process.exited; server.stop(true); rmSync(cwd, { recursive: true, force: true }) }
}, 15_000)
