import { describe, expect, test } from "bun:test"
import { initialSpeedOption, providerSetupNote } from "./ModelPicker.tsx"

describe("model picker provider setup guidance", () => {
  test("does not direct unconfigured Zen to OAuth login", () => {
    expect(providerSetupNote("zen", false)).toContain("ZEN_API_KEY")
    expect(providerSetupNote("zen", false)).not.toContain("/login")
  })

  test("keeps OAuth guidance for OAuth providers", () => {
    expect(providerSetupNote("codex", false)).toContain("/login")
    expect(providerSetupNote("codex", true)).toBe("")
  })
})

describe("model picker Codex speed defaults", () => {
  test("starts Luna on Fast and other Codex models on Standard", () => {
    expect(initialSpeedOption("gpt-5.6-luna")).toBe(1)
    expect(initialSpeedOption("gpt-5.6-terra")).toBe(0)
  })
})

import { modelSelectionSummary } from "./ModelPicker.js"

test("model summary calls out solo delegate suppression", () => {
  expect(modelSelectionSummary({ provider: "zen", model: "grok-4.5", effort: "high", solo: true }, true)).toBe("Model → zen / grok-4.5 · effort high · solo (mode delegates off)")
})
