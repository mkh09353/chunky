import { describe, expect, test } from "bun:test"
import { executorToolsFor, sidekickToolsFor } from "./agent.ts"
import { createChunkySdkMcpServer } from "./anthropic-runner.ts"
import { CORE_TOOL_NAMES } from "./tool-search.ts"
import { ANTHROPIC_SIDEKICK_TOOLS } from "./threads.ts"

const selection = { provider: "codex", model: "gpt-5.5" } as const

describe("notes registration", () => {
  test("lead and spawned-child executor catalog contains notes", () => {
    // Spawned LangChain children use the same agentFor/executorToolsFor factory.
    expect(executorToolsFor(selection).tools.map((tool) => tool.name)).toContain("notes")
  })
  test("LangChain and Anthropic sidekick catalogs contain notes", () => {
    expect(sidekickToolsFor(selection).map((tool) => tool.name)).toContain("notes")
    expect(ANTHROPIC_SIDEKICK_TOOLS).toContain("mcp__chunky__notes")
  })
  test("notes stays eager and is present in the Anthropic MCP registry", () => {
    expect(CORE_TOOL_NAMES).toContain("notes")
    const registry = (createChunkySdkMcpServer("notes-registration", () => {}).instance as any)._registeredTools
    expect(Object.keys(registry)).toContain("notes")
  })
})
