import { expect, test } from "bun:test"
import { buildSystemPrompt } from "./prompt.ts"

test("twin sidekick workers receive parallelization guidance", () => {
  const prompt = buildSystemPrompt("edit", false, "/tmp/workspace", {
    hasSidekick: true,
    sidekickSeats: ["luna2", "frontend"],
    sidekickConfig: { enabled: true, provider: "codex", model: "gpt-5.6-luna" },
    sidekickSeatConfigs: {
      luna2: { provider: "codex", model: "gpt-5.6-luna" },
      frontend: { provider: "anthropic", model: "claude-opus-5" },
    },
  })
  expect(prompt).toContain("TWIN WORKERS")
  expect(prompt).toContain("default and luna2")
})

test("distinct sidekick workers do not receive twin guidance", () => {
  const prompt = buildSystemPrompt("edit", false, "/tmp/workspace", {
    hasSidekick: true,
    sidekickSeats: ["frontend"],
    sidekickConfig: { enabled: true, provider: "codex", model: "gpt-5.6-terra" },
    sidekickSeatConfigs: {
      frontend: { provider: "anthropic", model: "claude-opus-5" },
    },
  })
  expect(prompt).not.toContain("TWIN WORKERS")
})
