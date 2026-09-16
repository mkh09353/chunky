import { expect, test } from "bun:test"
import { act } from "react"
import { testRender } from "@opentui/react/test-utils"
import { ModelPicker } from "./ModelPicker.js"
import { ProviderPicker } from "./ProviderPicker.js"

test("model picker fetches only connected enabled providers and preserves session scope", async () => {
  const calls: string[] = []
  const server = Bun.serve({ port: 0, fetch(req) {
    const url = new URL(req.url)
    calls.push(url.pathname)
    expect(url.searchParams.get("session")).toBe("private-session")
    if (url.pathname === "/api/providers") return Response.json({ providers: [
      { id: "grok", ready: false }, { id: "codex", ready: true, enabled: false }, { id: "telnyx", ready: true, enabled: true },
    ] })
    return Response.json({ models: [{ id: "test-model", name: "Test", reasoning: false }] })
  } })
  const ui = await testRender(<ModelPicker baseUrl={server.url.origin} sessionId="private-session" onDone={() => {}} onCancel={() => {}} />, { width: 100, height: 15 })
  try {
    await ui.waitForFrame((frame) => frame.includes("telnyx/test-model"))
    expect(calls).toEqual(["/api/providers", "/api/providers/telnyx/models"])
    expect(ui.captureCharFrame()).not.toContain("login needed")
    expect(ui.captureCharFrame()).not.toContain("grok/")
  } finally { await act(async () => ui.renderer.destroy()); server.stop(true) }
})

test("empty model picker explains how to connect or enable a provider and can close", async () => {
  let closed = false
  const server = Bun.serve({ port: 0, fetch: () => Response.json({ providers: [{ id: "grok", ready: false }] }) })
  const ui = await testRender(<ModelPicker baseUrl={server.url.origin} onDone={() => {}} onCancel={() => { closed = true }} />, { width: 110, height: 15 })
  try {
    await ui.waitForFrame((frame) => frame.includes("No models available"))
    expect(ui.captureCharFrame()).toContain("/onboard")
    expect(ui.captureCharFrame()).toContain("/settings")
    await act(async () => { ui.mockInput.pressEscape(); await Bun.sleep(40) })
    expect(closed).toBe(true)
  } finally { await act(async () => ui.renderer.destroy()); server.stop(true) }
})

test("provider settings persist toggles, retain state on failure, and do not browse disconnected models", async () => {
  let enabled = true, fail = true
  const requests: string[] = []
  const server = Bun.serve({ port: 0, async fetch(req) {
    const path = new URL(req.url).pathname
    requests.push(`${req.method} ${path}`)
    if (req.method === "PUT") {
      if (fail) return Response.json({ error: "fail" }, { status: 500 })
      enabled = (await req.json()).enabled
      return Response.json({ enabled })
    }
    return Response.json({ providers: [{ id: "codex", label: "Codex", enabled, ready: false }] })
  } })
  const ui = await testRender(<ProviderPicker baseUrl={server.url.origin} onDone={() => {}} onCancel={() => {}} />, { width: 110, height: 15 })
  try {
    await ui.waitForFrame((frame) => frame.includes("[not connected]"))
    await act(async () => ui.mockInput.pressEnter())
    await ui.waitForFrame((frame) => frame.includes("Connect this provider with /onboard"))
    expect(requests).toEqual(["GET /api/providers"])
    await act(async () => { ui.mockInput.typeText(" "); await Bun.sleep(30) })
    await ui.waitForFrame((frame) => frame.includes("Could not save"))
    expect(ui.captureCharFrame()).toContain("[on]")
    fail = false
    await act(async () => { ui.mockInput.typeText(" "); await Bun.sleep(30) })
    await ui.waitForFrame((frame) => frame.includes("[disabled]"))
    expect(enabled).toBe(false)
    await act(async () => ui.mockInput.pressEnter())
    await ui.waitForFrame((frame) => frame.includes("Enable this provider with Space"))
    await act(async () => { ui.mockInput.typeText(" "); await Bun.sleep(30) })
    await ui.waitForFrame((frame) => frame.includes("[not connected]"))
    expect(enabled).toBe(true)
  } finally { await act(async () => ui.renderer.destroy()); server.stop(true) }
})
