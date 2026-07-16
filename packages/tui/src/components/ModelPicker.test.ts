import { describe, expect, test } from "bun:test"
import { providerSetupNote } from "./ModelPicker.tsx"

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
