// A child spawned on a provider whose sign-in preflight fails must surface ONE
// actionable provider-auth error event and hand the model a clear error string.
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
process.env.CHUNKY_SETTINGS = join(mkdtempSync(join(tmpdir(), "chunky-auth-preflight-")), "settings.json")

import { describe, expect, test } from "bun:test"
import type { AgentEvent } from "@chunky/protocol"
import { getProvider, registerProvider, type AgentSelection } from "./providers/registry.ts"
import { ThreadManager } from "./threads.ts"
import { Store } from "./store.ts"

describe("provider auth preflight", () => {
  test("child spawn emits exactly one provider-auth error and returns an error report", async () => {
    const original = getProvider("grok")!
    registerProvider({
      id: "grok",
      label: "Grok test",
      billing: "unknown",
      ready: () => true,
      listModels: async () => [],
      buildModel: () => { throw new Error("model construction must not run") },
      ensureAuth: async () => { throw new Error("OAuth session expired and could not be refreshed") },
    })
    const root = `auth-preflight-${process.pid}`
    Store.createSession(root)
    const events: AgentEvent[] = []
    const selection: AgentSelection = Object.freeze({ provider: "grok", model: "test", effort: "medium" })
    const manager = new ThreadManager((event) => events.push(event), root, selection)
    try {
      const report = await manager.spawn({ callerThreadId: root, title: "child", instructions: "do nothing" })
      expect(report.startsWith("error: Grok test: OAuth session expired and could not be refreshed")).toBe(true)
      expect(events.filter((event) => event.type === "error")).toEqual([
        { type: "error", code: "provider-auth", provider: "grok", message: "Grok test: OAuth session expired and could not be refreshed" },
      ])
      expect(events.some((event) => event.type === "thread.spawn")).toBe(false)
    } finally {
      manager.dispose()
      registerProvider(original)
    }
  })
})
