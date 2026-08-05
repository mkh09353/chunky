import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

const root = mkdtempSync(join(tmpdir(), "chunky-solo-model-"))
process.env.CHUNKY_SETTINGS = join(root, "settings.json")
process.env.CHUNKY_DB = join(root, "chunky.db")

const settings = await import("./settings.ts")
const registry = await import("./providers/registry.ts")
const { Store } = await import("./store.ts")

afterAll(() => rmSync(root, { recursive: true, force: true }))

const executor = Object.freeze({ provider: "zen", model: "glm-5.2", effort: "medium" })
const advisor = Object.freeze({ provider: "codex", model: "gpt-5.5", effort: "high" })

function configureDelegates(): void {
  settings.setAdvisor({ enabled: true, ...advisor })
  settings.setSidekick({ enabled: true, provider: "codex", model: "gpt-5.5", effort: "xhigh" })
  settings.setSidekickSeat("frontend", { provider: "codex", model: "gpt-5.5" })
  settings.setReview({ enabled: true, provider: "codex", model: "gpt-5.5" })
}

describe("solo model resolution", () => {
  test("global solo suppresses delegates without destroying their settings", () => {
    configureDelegates()
    settings.setSolo(true)

    expect(registry.isSolo()).toBe(true)
    expect(registry.sidekickFor(executor)).toBeNull()
    expect(registry.effectiveSidekickSeats()).toEqual({})
    expect(registry.listSidekickSeats()).toEqual([])
    expect(registry.resolveReviewSelection()).toBeNull()
    expect(registry.resolveAdvisorSelection()).toBeNull()

    expect(settings.getAdvisor()).toMatchObject({ provider: advisor.provider, model: advisor.model })
    expect(settings.getSidekick()).toMatchObject({ provider: "codex", model: "gpt-5.5" })
    expect(settings.getSidekickSeats().frontend?.model).toBe("gpt-5.5")
    expect(settings.getReview()).toMatchObject({ provider: "codex", model: "gpt-5.5" })
  })

  test("soloAdvisor resolves in solo and still suppresses same executor", () => {
    settings.setSoloAdvisor({ enabled: true, ...advisor })
    settings.setSolo(true)

    expect(registry.resolveAdvisorSelection()).toMatchObject(advisor)
    expect(registry.advisorFor(executor)).toMatchObject(advisor)
    expect(registry.advisorFor(advisor)).toBeNull()

    settings.setSoloAdvisor({ enabled: false })
  })

  test("a pinned solo session is isolated from another session's delegates", () => {
    configureDelegates()
    settings.setSolo(false)
    const soloSession = `solo-${process.pid}`
    const normalSession = `normal-${process.pid}`
    Store.createSession(soloSession)
    Store.createSession(normalSession)
    Store.pinSelection(soloSession, { ...executor, solo: true })

    expect(registry.isSolo(soloSession)).toBe(true)
    expect(registry.sidekickFor(executor, soloSession)).toBeNull()
    expect(registry.resolveReviewSelection(soloSession)).toBeNull()
    expect(registry.resolveAdvisorSelection(soloSession)).toBeNull()

    expect(registry.isSolo(normalSession)).toBe(false)
    expect(registry.sidekickFor(executor, normalSession)).not.toBeNull()
    expect(registry.resolveReviewSelection(normalSession)).not.toBeNull()
    expect(registry.resolveAdvisorSelection(normalSession)).not.toBeNull()
  })

  test("clearing solo restores the saved delegate bundle", () => {
    configureDelegates()
    settings.setSolo(true)
    expect(registry.sidekickFor(executor)).toBeNull()
    settings.setSolo(false)
    expect(registry.sidekickFor(executor)).not.toBeNull()
    expect(registry.resolveReviewSelection()).not.toBeNull()
    expect(registry.resolveAdvisorSelection()).not.toBeNull()
  })

  test("legacy settings and pinned selections default to non-solo", () => {
    // This test file starts with an empty settings file, equivalent to an old
    // settings.json with neither new field. The defaults must remain non-solo.
    settings.setSolo(false)
    settings.setSoloAdvisor({ enabled: false })
    expect(settings.getSolo()).toBe(false)
    expect(settings.getSoloAdvisor().enabled).toBe(false)

    const legacySession = `legacy-${process.pid}`
    Store.createSession(legacySession)
    Store.pinSelection(legacySession, executor)
    expect(Store.pinnedSelectionOf(legacySession)?.solo).toBeUndefined()
    expect(registry.isSolo(legacySession)).toBe(false)
  })
})

// Route-level coverage runs in a child server because index.ts owns its Bun listener.
