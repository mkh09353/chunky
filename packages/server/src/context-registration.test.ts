import { describe, expect, test } from "bun:test"
import { buildAdvisorAgent, executorToolsFor, sidekickToolsFor } from "./agent.ts"
import { createChunkySdkMcpServer } from "./anthropic-runner.ts"
import { CORE_TOOL_NAMES } from "./tool-search.ts"

const selection = { provider: "codex", model: "gpt-5.5" } as const
const names = ["get_context_remaining", "compact_context"]

describe("context budget tool registration", () => {
  test("lead and spawned-child executor catalog contains both tools", () => {
    const registered = executorToolsFor(selection).tools.map((tool) => tool.name)
    for (const name of names) expect(registered).toContain(name)
  })
  test("LangChain sidekick catalog contains both tools", () => {
    const registered = sidekickToolsFor(selection).map((tool) => tool.name)
    for (const name of names) expect(registered).toContain(name)
  })
  test("both tools stay eager and are present in the Anthropic MCP registry", () => {
    for (const name of names) expect(CORE_TOOL_NAMES as readonly string[]).toContain(name)
    const registry = (createChunkySdkMcpServer("context-registration", () => {}).instance as any)._registeredTools
    for (const name of names) expect(Object.keys(registry)).toContain(name)
    expect(registry.get_context_remaining.annotations?.readOnlyHint).toBe(true)
  })
  test("advisor tool list source registers both tools", async () => {
    const source = await Bun.file(new URL("./agent.ts", import.meta.url)).text()
    const advisor = source.slice(source.indexOf("export function buildAdvisorAgent"), source.indexOf("export function buildAdvisorAgent") + 600)
    expect(advisor).toContain("get_context_remaining")
    expect(advisor).toContain("compact_context")
    expect(typeof buildAdvisorAgent).toBe("function")
  })
})
