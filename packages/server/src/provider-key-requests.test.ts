import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Store } from "./store.ts"
import { installSessionBus, resetSessionBus } from "./session-bus.ts"

const dir = mkdtempSync(join(tmpdir(), "chunky-provider-key-test-"))
process.env.CHUNKY_AUTH = join(dir, "auth.json")
const { AuthStore } = await import("./providers/auth-store.ts")
const {
  createKeyRequest,
  pendingKeyRequestIdsForTest,
  submitProviderKey,
  timeoutKeyRequestForTest,
} = await import("./provider-key-requests.ts")

afterEach(() => resetSessionBus())
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function captureLiveEvents() {
  const events: Array<{ sessionId: string; event: any }> = []
  installSessionBus({
    emitUserMessage() {},
    emitEvent() {},
    emitLiveEvent(sessionId, event) { events.push({ sessionId, event }) },
    dispatch: async () => {},
    isRunning: () => false,
  })
  return events
}

describe("desktop provider key requests", () => {
  test("submission stores a key and resolves all pending requests for the provider", async () => {
    const events = captureLiveEvents()
    const first = createKeyRequest("private", "Private", "session-one")
    const second = createKeyRequest("private", "Private", "session-two")
    const requestId = events[0]!.event.requestId as string

    expect(submitProviderKey("private", { requestId, key: "  secret with spaces  " })).toEqual({ ok: true })
    expect(await first).toBe("stored")
    expect(await second).toBe("stored")
    expect(AuthStore.getApiKey("private")).toBe("  secret with spaces  ")
    expect(pendingKeyRequestIdsForTest()).toEqual([])
  })

  test("empty submission cancels its matching pending request", async () => {
    const events = captureLiveEvents()
    const result = createKeyRequest("cancelled", "Cancelled", "session-cancel")
    const requestId = events[0]!.event.requestId as string

    expect(submitProviderKey("cancelled", { requestId, key: "" })).toEqual({ ok: true })
    expect(await result).toBe("cancelled")
    expect(AuthStore.getApiKey("cancelled")).toBeUndefined()
  })

  test("pending requests resolve as timeout and clean up", async () => {
    const events = captureLiveEvents()
    const result = createKeyRequest("slow", "Slow", "session-timeout")
    const requestId = events[0]!.event.requestId as string

    expect(timeoutKeyRequestForTest(requestId)).toBe(true)
    expect(await result).toBe("timeout")
    expect(pendingKeyRequestIdsForTest()).toEqual([])
  })

  test("API key requests are live-only and never persisted to session history", async () => {
    const sessionId = `provider-key-${crypto.randomUUID()}`
    const events = captureLiveEvents()
    Store.createSession(sessionId)
    const result = createKeyRequest("history-safe", "History Safe", sessionId)
    const event = events[0]!.event

    expect(event).toMatchObject({ type: "app.request_api_key", providerId: "history-safe", label: "History Safe" })
    expect(typeof event.requestId).toBe("string")
    expect(Store.history(sessionId).some((item) => item.type === "app.request_api_key")).toBe(false)
    submitProviderKey("history-safe", { requestId: event.requestId })
    expect(await result).toBe("cancelled")
  })
})
