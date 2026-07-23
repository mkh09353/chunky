import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { createIsolatedTestState, removeIsolatedTestState } from "./test-state.ts"

describe("isolated test state", () => {
  test("creates disposable database and settings paths under a unique temp root", () => {
    const state = createIsolatedTestState("chunky-state-test-")
    expect(state.db.startsWith(state.root)).toBe(true)
    expect(state.settings.startsWith(state.root)).toBe(true)

    removeIsolatedTestState(state.root, "chunky-state-test-")
    expect(existsSync(state.root)).toBe(false)
  })

  test("refuses cleanup outside the expected temporary prefix", () => {
    expect(() => removeIsolatedTestState("/Users/example/.chunky/state", "chunky-state-test-"))
      .toThrow("refusing unsafe test cleanup")
  })
})
