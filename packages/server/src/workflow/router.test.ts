import { describe, expect, test } from "bun:test"
import {
  chooseWorkflowTarget,
  defaultWorkflowTarget,
  type WorkflowTarget,
} from "./router.ts"

const targets: WorkflowTarget[] = [
  defaultWorkflowTarget("codex", "gpt-5.6-sol", "GPT-5.6 Sol"),
  defaultWorkflowTarget("codex", "gpt-5.6-luna", "GPT-5.6 Luna"),
  defaultWorkflowTarget("grok", "grok-4.5", "Grok 4.5"),
  defaultWorkflowTarget("anthropic", "opus[1m]", "Opus 4.8"),
  defaultWorkflowTarget("zen", "grok-4.5", "Grok 4.5"),
  defaultWorkflowTarget("zen", "glm-5-free", "GLM 5 Free"),
]

describe("workflow target defaults", () => {
  test("qualifies identical models by provider and billing route", () => {
    const grokSubscription = targets.find((target) => target.provider === "grok")!
    const grokMetered = targets.find((target) => target.provider === "zen" && target.model === "grok-4.5")!
    expect(grokSubscription.billing).toBe("subscription")
    expect(grokSubscription.automatic).toBe(true)
    expect(grokMetered.billing).toBe("metered")
    expect(grokMetered.automatic).toBe(false)
  })

  test("recognizes known-free API models as automatic candidates", () => {
    const free = targets.find((target) => target.model === "glm-5-free")!
    expect(free.billing).toBe("free")
    expect(free.automatic).toBe(true)
  })

  test("does not infer free billing from preview-like names", () => {
    const preview = defaultWorkflowTarget("zen", "some-free-preview", "Free Preview")
    expect(preview.billing).toBe("metered")
    expect(preview.automatic).toBe(false)
  })
})

describe("workflow target routing", () => {
  test("uses Luna xhigh as the zero-config general worker instead of Sol", () => {
    expect(chooseWorkflowTarget(targets, { tags: ["general"] })?.selection).toEqual({
      provider: "codex",
      model: "gpt-5.6-luna",
      effort: "xhigh",
    })
  })

  test("routes research to the Grok subscription, never the same metered Zen model", () => {
    expect(chooseWorkflowTarget(targets, { tags: ["research", "fast"] })?.selection).toEqual({
      provider: "grok",
      model: "grok-4.5",
      effort: "high",
    })
  })

  test("respects a frontend specialty tag", () => {
    expect(chooseWorkflowTarget(targets, { tags: ["frontend"] })?.selection).toEqual({
      provider: "anthropic",
      model: "opus[1m]",
      effort: "high",
    })
  })

  test("does not silently substitute a generalist for an unavailable specialty", () => {
    expect(chooseWorkflowTarget(targets.filter((target) => target.provider !== "anthropic"), { tags: ["frontend"] })).toBeNull()
  })

  test("allows a metered target only after the user opts it into automatic routing", () => {
    const onlyMetered = targets
      .filter((target) => target.provider === "zen" && target.model === "grok-4.5")
      .map((target) => ({ ...target, automatic: true, tags: [...target.tags, "research"] }))
    expect(chooseWorkflowTarget(onlyMetered, { tags: ["research"] })?.selection.provider).toBe("zen")
  })
})
