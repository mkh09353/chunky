// Modes (named executor+advisor pairings): CRUD + current-pairing snapshot.
import { describe, expect, test } from "bun:test"
import { rmSync } from "node:fs"

// Isolated settings file, set BEFORE settings.ts loads (it reads the env lazily
// but caches after first load — same pattern as the other env-pinned tests).
process.env.CHUNKY_SETTINGS ||= "/tmp/chunky-modes-test.json"
try {
  rmSync("/tmp/chunky-modes-test.json")
} catch {
  /* not there yet */
}

const { listModes, getMode, saveMode, deleteMode, currentModeSpec, setPersistedProvider, setSelectionFor, setAdvisor } =
  await import("./settings.ts")

describe("modes", () => {
  test("save / get / list / delete roundtrip", () => {
    expect(listModes().find((m) => m.name === "grok-test")).toBeUndefined()
    saveMode("grok-test", {
      provider: "grok",
      model: "grok-4.5",
      effort: "high",
      advisor: { provider: "anthropic", model: "default", effort: "high" },
    })
    const loaded = getMode("grok-test")
    expect(loaded?.model).toBe("grok-4.5")
    expect(loaded?.advisor?.provider).toBe("anthropic")
    expect(listModes().map((m) => m.name)).toContain("grok-test")
    expect(deleteMode("grok-test")).toBe(true)
    expect(deleteMode("grok-test")).toBe(false)
    expect(getMode("grok-test")).toBeUndefined()
  })

  test("a mode can pin the advisor OFF (null), distinct from unset", () => {
    saveMode("solo-test", { provider: "zen", model: "glm-5.2", advisor: null })
    expect(getMode("solo-test")?.advisor).toBeNull()
    deleteMode("solo-test")
  })

  test("currentModeSpec snapshots the active pairing", () => {
    setPersistedProvider("grok")
    setSelectionFor("grok", { model: "grok-4.5", effort: "high" })
    setAdvisor({ enabled: true, provider: "codex", model: "gpt-5.6-sol", effort: "xhigh" })
    const spec = currentModeSpec()
    expect(spec).toMatchObject({
      provider: "grok",
      model: "grok-4.5",
      effort: "high",
      advisor: { provider: "codex", model: "gpt-5.6-sol", effort: "xhigh" },
    })
    setAdvisor({ enabled: false })
    expect(currentModeSpec().advisor).toBeNull()
    setAdvisor({ enabled: true })
  })
})
