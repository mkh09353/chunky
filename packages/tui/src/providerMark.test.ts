import { describe, expect, test } from "bun:test"
import { providerMark, providerModelLabel } from "./providerMark.ts"

describe("providerMark", () => {
  test("uses stable marks for built-in providers", () => {
    expect(["codex", "zen", "grok", "anthropic"].map(providerMark)).toEqual(["C", "Z", "G", "A"])
  })

  test("falls back cleanly for custom and missing providers", () => {
    expect(providerMark("openrouter")).toBe("O")
    expect(providerMark(undefined)).toBe("?")
  })

  test("joins the mark and model without adding status-line bulk", () => {
    expect(providerModelLabel("codex", "GPT 5.6 Terra")).toBe("C·GPT 5.6 Terra")
  })
})
