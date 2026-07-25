import { describe, expect, test } from "bun:test"
import {
  activeExecutorModelLabel,
  prettyModel,
  providerMark,
  providerModelLabel,
} from "./providerMark.ts"

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

describe("prettyModel", () => {
  test("title-cases ids and uppercases known acronyms", () => {
    expect(prettyModel("grok-4.5")).toBe("Grok 4.5")
    expect(prettyModel("glm-5.2")).toBe("GLM 5.2")
    expect(prettyModel("gpt-5.5")).toBe("GPT 5.5")
  })

  test("strips bracketed variant tags used by aliases", () => {
    expect(prettyModel("opus[1m]")).toBe("Opus")
    expect(prettyModel("claude-opus-4-1-20250805")).toBe("Claude Opus 4 1 20250805")
  })
})

describe("activeExecutorModelLabel", () => {
  test("returns null until a configured or resolved model exists", () => {
    expect(activeExecutorModelLabel({ provider: "anthropic", configuredModel: null })).toBeNull()
    expect(activeExecutorModelLabel({ provider: "anthropic", configuredModel: undefined })).toBeNull()
  })

  test("shows the configured alias before any usage report", () => {
    expect(
      activeExecutorModelLabel({
        provider: "anthropic",
        configuredModel: "opus[1m]",
        effort: "high",
      }),
    ).toBe("A·Opus high")
  })

  test("prefers the provider-reported concrete model once known", () => {
    expect(
      activeExecutorModelLabel({
        provider: "anthropic",
        configuredModel: "opus[1m]",
        resolvedModel: "claude-opus-4-1-20250805",
        effort: "high",
      }),
    ).toBe("A·Claude Opus 4 1 20250805 high")
  })

  test("omits effort when unset and still provider-qualifies", () => {
    expect(
      activeExecutorModelLabel({
        provider: "codex",
        configuredModel: "gpt-5.5",
      }),
    ).toBe("C·GPT 5.5")
  })

  test("resolved model alone is enough after a selection wipe race", () => {
    // Defensive: if configured is briefly empty but usage already landed.
    expect(
      activeExecutorModelLabel({
        provider: "anthropic",
        configuredModel: null,
        resolvedModel: "claude-opus-4-1-20250805",
      }),
    ).toBe("A·Claude Opus 4 1 20250805")
  })
})
