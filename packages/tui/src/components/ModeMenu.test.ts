import { expect, test } from "bun:test"
import type { ModeSpec } from "@chunky/protocol"
import { previewSpec } from "./ModeMenu.js"

test("full trio preview matches the compact one-line format", () => {
  const spec: ModeSpec = {
    provider: "zen",
    model: "claude-fable-5",
    effort: "low",
    sidekick: { provider: "zen", model: "luna-2", effort: "xhigh" },
    sidekickSeats: { frontend: { provider: "zen", model: "claude-opus-4" } },
    advisor: { provider: "openai", model: "sol-1" },
  }
  expect(previewSpec(spec)).toBe("Claude Fable 5 low · ⚒ Luna 2 xhigh · frontend=Claude Opus 4 · ✦ Sol 1")
})

test("advisor off renders '✦ off' and sidekick unset renders '⚒ inherit'", () => {
  const spec: ModeSpec = {
    provider: "zen",
    model: "grok-4.5",
    advisor: null,
    sidekick: null,
  }
  expect(previewSpec(spec)).toBe("Grok 4.5 · ⚒ inherit · ✦ off")
})

test("seats are sorted by name and omitted when empty", () => {
  const spec: ModeSpec = {
    provider: "zen",
    model: "glm-5",
    sidekickSeats: {
      backend: { provider: "zen", model: "luna-2", effort: "high" },
      api: { provider: "zen", model: "sol-1" },
    },
    advisor: { provider: "zen", model: "sol-1", effort: "medium" },
  }
  expect(previewSpec(spec)).toBe("GLM 5 · ⚒ inherit · api=Sol 1 · backend=Luna 2 high · ✦ Sol 1 medium")
})
