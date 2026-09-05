import { describe, expect, test } from "bun:test"
import { CHUNKY_TOOLS, createChunkySdkMcpServer } from "./anthropic-runner.ts"
import { sidekickToolsFor } from "./agent.ts"
import { ANTHROPIC_SIDEKICK_TOOLS } from "./threads.ts"

describe("Anthropic SDK tool parity", () => {
  test("CHUNKY_TOOLS includes recall and update_todos", () => {
    const names = CHUNKY_TOOLS.map((tool) => tool.name)
    expect(names).toContain("recall")
    expect(names).toContain("update_todos")
  })
  test("the SDK MCP registry exposes recall (read-only) and update_todos", () => {
    const registry = (createChunkySdkMcpServer("anthropic-parity", () => {}).instance as any)._registeredTools
    expect(Object.keys(registry)).toContain("recall")
    expect(Object.keys(registry)).toContain("update_todos")
    expect(registry.recall.annotations?.readOnlyHint).toBe(true)
  })
  test("sidekicks get recall but not update_todos", () => {
    expect(ANTHROPIC_SIDEKICK_TOOLS).toContain("mcp__chunky__recall")
    expect(ANTHROPIC_SIDEKICK_TOOLS).not.toContain("mcp__chunky__update_todos")
    expect(sidekickToolsFor({ provider: "codex", model: "gpt-5.5" } as any).map((tool) => tool.name)).toContain("recall")
  })
})
