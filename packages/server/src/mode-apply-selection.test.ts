// The mode-apply route (POST /api/modes/:name/apply in index.ts) switches the
// active provider + selection as one unit. This test pins down the contract the
// route depends on and that runAgent (run.ts ~301) reads for the NEXT root turn:
// after applying a mode, activeSelection() must reflect that mode's
// provider/model/knobs. An in-flight turn keeps its frozen selection; the newly
// applied mode only affects the next root turn — so verifying activeSelection()
// (what a fresh, non-pinned run freezes) is the meaningful seam.
//
// The apply handler is inline in Bun.serve (not separately exported), and
// importing index.ts would start a real server, so this test drives the exact
// registry/settings primitives the handler composes rather than the HTTP route.
import { describe, expect, test } from "bun:test"
import { rmSync } from "node:fs"

process.env.CHUNKY_SETTINGS ||= "/tmp/chunky-mode-apply-test.json"
try {
  rmSync("/tmp/chunky-mode-apply-test.json")
} catch {
  /* not there yet */
}

const { saveMode, getMode, deleteMode } = await import("./settings.ts")
const { setActiveProviderId, setSelection, activeSelection, getProvider } = await import("./providers/registry.ts")

// Mirror the apply route's selection effect for a saved mode's spec.
function applyMode(name: string): void {
  const spec = getMode(name)
  if (!spec) throw new Error(`unknown mode "${name}"`)
  setActiveProviderId(spec.provider)
  setSelection(spec.provider, { model: spec.model, effort: spec.effort, speed: spec.speed })
}

// Mirror run.ts: a non-pinned root run freezes activeSelection() at turn start.
function nextRootTurnSelection() {
  return activeSelection()
}

describe("mode apply → next root turn selection", () => {
  test("applying a mode persists its provider + model for the next root turn", () => {
    saveMode("nrt-grok", { provider: "grok", model: "grok-4.5", effort: "high" })
    expect(getProvider("grok")).toBeTruthy()

    applyMode("nrt-grok")

    const sel = nextRootTurnSelection()
    expect(sel.provider).toBe("grok")
    expect(sel.model).toBe("grok-4.5")
    expect(sel.effort).toBe("high")

    deleteMode("nrt-grok")
  })

  test("applying a second mode switches provider + model for the following turn", () => {
    saveMode("nrt-grok", { provider: "grok", model: "grok-4.5", effort: "high" })
    saveMode("nrt-zen", { provider: "zen", model: "glm-5.2", effort: "low" })

    applyMode("nrt-grok")
    expect(nextRootTurnSelection().provider).toBe("grok")

    // A fresh apply (as if the user picked another saved mode from the menu)
    // must be what the *next* turn sees — not the previous mode.
    applyMode("nrt-zen")
    const sel = nextRootTurnSelection()
    expect(sel.provider).toBe("zen")
    expect(sel.model).toBe("glm-5.2")
    expect(sel.effort).toBe("low")

    deleteMode("nrt-grok")
    deleteMode("nrt-zen")
  })

  test("mode name resolves case-insensitively (matches the /mode apply flow)", () => {
    saveMode("nrt-grok", { provider: "grok", model: "grok-4.5" })
    // getMode is case-insensitive; the TUI hands the canonical name, but a typed
    // /NRT-GROK must still apply.
    expect(getMode("NRT-GROK")?.model).toBe("grok-4.5")
    deleteMode("nrt-grok")
  })
})
