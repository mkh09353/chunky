import { expect, test } from "bun:test"
import { act, useState } from "react"
import { testRender } from "@opentui/react/test-utils"
import { OnboardingWizard } from "./OnboardingWizard.js"

test("Telnyx setup needs only a masked, pasteable key and supports retry and completion", async () => {
  const saved: unknown[] = []
  let reject = true
  let ready = false
  let done = false
  let onboardingRequests = 0
  let rerender = () => {}
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (new URL(req.url).pathname === "/api/providers/telnyx/key") {
        saved.push(await req.json())
        if (reject) return Response.json({ error: "rejected" }, { status: 400 })
        ready = true
        return Response.json({ ok: true })
      }
      onboardingRequests++
      return Response.json({ providers: [{ id: "telnyx", label: "Telnyx", status: ready ? "ready" : "missing" }], suggestedModes: [
        { name: "fire", description: "Requires other providers", locked: true, spec: { provider: "anthropic", model: "unavailable" } },
      ] })
    },
  })
  function Scene() {
    const [, setRevision] = useState(0)
    rerender = () => setRevision((value) => value + 1)
    return <OnboardingWizard baseUrl={server.url.origin} onDone={() => { done = true }} />
  }
  const ui = await testRender(<Scene />, { width: 90, height: 15 })
  try {
    await ui.waitForFrame((frame) => frame.includes("✗ Telnyx"))
    await act(async () => { ui.mockInput.pressEnter() })
    await ui.waitForFrame((frame) => frame.includes("Connect Telnyx"))
    await act(async () => { await ui.mockInput.pasteBracketedText("  test-secret\n") })
    await ui.flush()
    expect(ui.captureCharFrame()).toContain("API key: •")
    expect(ui.captureCharFrame()).not.toContain("test-secret")
    expect(ui.captureCharFrame()).not.toContain("baseURL:")
    await act(async () => { rerender(); await Bun.sleep(30) })
    expect(onboardingRequests).toBe(1)
    expect(ui.captureCharFrame()).toContain("API key: •")
    await act(async () => { ui.mockInput.pressEnter(); await Bun.sleep(30) })
    await ui.waitForFrame((frame) => frame.includes("Could not complete Telnyx setup"))
    expect(saved).toEqual([{ key: "test-secret" }])
    reject = false
    await act(async () => { ui.mockInput.pressEnter(); await Bun.sleep(30) })
    await ui.waitForFrame((frame) => frame.includes("✓ Telnyx"))
    expect(saved).toEqual([{ key: "test-secret" }, { key: "test-secret" }])
    await act(async () => { ui.mockInput.pressEnter() })
    await ui.waitForFrame((frame) => frame.includes("Connect Telnyx"))
    expect(ui.captureCharFrame()).not.toContain("•")
    await act(async () => { ui.mockInput.pressEscape(); await Bun.sleep(40) })
    await ui.waitForFrame((frame) => frame.includes("connect a provider"))
    expect(done).toBe(false)
    await act(async () => { ui.mockInput.pressArrow("down") })
    await act(async () => { ui.mockInput.pressEnter() })
    await ui.waitForFrame((frame) => frame.includes("You're set!"))
    await act(async () => { ui.mockInput.pressEnter(); await Bun.sleep(30) })
    expect(done).toBe(true)
  } finally {
    await act(async () => { ui.renderer.destroy() })
    server.stop(true)
  }
})
