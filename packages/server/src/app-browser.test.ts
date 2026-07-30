import { expect, test } from "bun:test"
import { appBrowserTier, getAppBrowserEndpoint, resetAppBrowserEndpoint, setAppBrowserEndpoint } from "./app-browser.ts"
import { buildSystemPrompt } from "./prompt.ts"
import { open_app_browser } from "./tools/browser.ts"
import { registerThread, unregisterThread } from "./thread-context.ts"
import { Store } from "./store.ts"
import { installSessionBus, resetSessionBus } from "./session-bus.ts"
import { executorToolsFor, getAgent, invalidateAgent } from "./agent.ts"
import { createChunkySdkMcpServer } from "./anthropic-runner.ts"

const SELECTION = { provider: "codex", model: "gpt-5.5" } as const
const CDP_TOOLS = ["browser_navigate", "browser_snapshot", "browser_click", "browser_type", "browser_press_key", "browser_scroll", "browser_back", "browser_forward", "browser_screenshot", "browser_evaluate"]
function toolNames() { return executorToolsFor(SELECTION).tools.map((tool) => tool.name) }
function sdkToolNames() {
  return Object.keys((createChunkySdkMcpServer("app-browser-test", () => {}).instance as any)._registeredTools)
}
function expectBrowserTools(names: string[], tier: "open" | "cdp" | undefined) {
  expect(names.includes("open_app_browser")).toBe(tier != null)
  for (const name of CDP_TOOLS) expect(names.includes(name)).toBe(tier === "cdp")
}

test("app browser endpoint state validates and resets", () => {
  resetAppBrowserEndpoint()
  expect(getAppBrowserEndpoint()).toBeNull()
  setAppBrowserEndpoint({ cdpPort: 9223, renderer: "cef", debuggable: true })
  expect(getAppBrowserEndpoint()?.cdpUrl).toBe("http://127.0.0.1:9223")
  expect(appBrowserTier()).toBe("cdp")
  resetAppBrowserEndpoint()
  expect(getAppBrowserEndpoint()).toBeNull()
  expect(appBrowserTier()).toBeUndefined()
})

test("desktop browser prompt guidance has none, open, and CDP tiers", () => {
  const browserGuidance = "the Chunky desktop app with a built-in browser pane"
  resetAppBrowserEndpoint()
  expect(buildSystemPrompt("edit", false, "/tmp/workspace", { appBrowser: appBrowserTier() })).not.toContain(browserGuidance)

  setAppBrowserEndpoint({ cdpPort: 9223, renderer: "native", debuggable: true })
  const openPrompt = buildSystemPrompt("edit", false, "/tmp/workspace", { appBrowser: appBrowserTier() })
  expect(openPrompt).toContain(browserGuidance)
  expect(openPrompt).toContain("open_app_browser")
  expect(openPrompt).not.toContain("browser_navigate")

  setAppBrowserEndpoint({ cdpPort: 9223, renderer: "cef", debuggable: true })
  const cdpPrompt = buildSystemPrompt("edit", false, "/tmp/workspace", { appBrowser: appBrowserTier() })
  expect(cdpPrompt).toContain("open_app_browser")
  expect(cdpPrompt).toContain("browser_navigate")
  resetAppBrowserEndpoint()
})

test("both lead paths register only app-browser tools supported by the tier", () => {
  resetAppBrowserEndpoint()
  expectBrowserTools(toolNames(), undefined)
  expectBrowserTools(sdkToolNames(), undefined)

  setAppBrowserEndpoint({ cdpPort: 9223, renderer: "native", debuggable: false })
  expectBrowserTools(toolNames(), "open")
  expectBrowserTools(sdkToolNames(), "open")

  setAppBrowserEndpoint({ cdpPort: 9223, renderer: "cef", debuggable: true })
  expectBrowserTools(toolNames(), "cdp")
  expectBrowserTools(sdkToolNames(), "cdp")
  resetAppBrowserEndpoint()
})

test("tier changes invalidate cached agents but same-tier announcements do not", () => {
  resetAppBrowserEndpoint()
  invalidateAgent()
  const absent = getAgent(SELECTION, "/tmp/app-browser-cache")
  expect(getAgent(SELECTION, "/tmp/app-browser-cache")).toBe(absent)

  setAppBrowserEndpoint({ cdpPort: 9223, renderer: "native", debuggable: false })
  const open = getAgent(SELECTION, "/tmp/app-browser-cache")
  expect(open).not.toBe(absent)
  setAppBrowserEndpoint({ cdpPort: 9224, renderer: "native", debuggable: false })
  expect(getAgent(SELECTION, "/tmp/app-browser-cache")).toBe(open)

  setAppBrowserEndpoint({ cdpPort: 9223, renderer: "cef", debuggable: true })
  const cdp = getAgent(SELECTION, "/tmp/app-browser-cache")
  expect(cdp).not.toBe(open)
  resetAppBrowserEndpoint()
  expect(getAgent(SELECTION, "/tmp/app-browser-cache")).not.toBe(cdp)
  invalidateAgent()
})

test("open_app_browser requires an announced app endpoint and http(s) URL", async () => {
  resetAppBrowserEndpoint()
  const absent = await open_app_browser.invoke({ url: "https://example.test" })
  expect(absent.ok).toBe(false)
  expect(absent.promptText).toContain("the Chunky desktop app isn't running")

  setAppBrowserEndpoint({ cdpPort: 9223, renderer: "native", debuggable: false })
  const invalid = await open_app_browser.invoke({ url: "file:///tmp/result.html" })
  expect(invalid.ok).toBe(false)
  expect(invalid.promptText).toContain("http or https")
  resetAppBrowserEndpoint()
})

test("open_app_browser emits a live-only session event without persisting it", async () => {
  const sessionId = `app-browser-${crypto.randomUUID()}`
  const events: Array<{ sessionId: string; event: unknown }> = []
  Store.createSession(sessionId)
  registerThread(sessionId, { sessionId } as any)
  setAppBrowserEndpoint({ cdpPort: 9223, renderer: "native", debuggable: false })
  installSessionBus({
    emitUserMessage() {},
    emitEvent() {},
    emitLiveEvent(id, event) { events.push({ sessionId: id, event }) },
    dispatch: async () => {},
    isRunning: () => false,
  })

  try {
    const result = await open_app_browser.invoke(
      { url: "http://127.0.0.1:3000/result" },
      { configurable: { thread_id: sessionId } },
    )
    expect(result.ok).toBe(true)
    expect(result.promptText).toBe("Opened http://127.0.0.1:3000/result in the user's app browser.")
    expect(events).toEqual([{ sessionId, event: { type: "app.open_url", url: "http://127.0.0.1:3000/result" } }])
    expect(Store.history(sessionId).some((event) => event.type === "app.open_url")).toBe(false)
  } finally {
    resetSessionBus()
    unregisterThread(sessionId)
    resetAppBrowserEndpoint()
  }
})
