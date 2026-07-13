// Unit tests for native provider tool search gating + core/deferred partition.
// Run: bun test packages/server/src/tool-search.test.ts
import { describe, expect, test } from "bun:test"
import { tool } from "@langchain/core/tools"
import { z } from "zod"
import {
  CORE_TOOL_NAMES,
  buildToolSearchMiddleware,
  deferredToolNames,
  isCoreToolName,
  isGptVersionAtLeast,
  parseGptVersion,
  partitionTools,
  portableToolSetFor,
  supportsNativeToolSearch,
  toolSearchMiddlewareConfigFor,
} from "./tool-search.ts"
import { agentPlanFor, executorToolsFor } from "./agent.ts"
import { buildSystemPrompt } from "./prompt.ts"

describe("parseGptVersion / isGptVersionAtLeast", () => {
  test("parses gpt major.minor and bare major", () => {
    expect(parseGptVersion("gpt-5.4")).toEqual({ major: 5, minor: 4 })
    expect(parseGptVersion("gpt-5.4-mini")).toEqual({ major: 5, minor: 4 })
    expect(parseGptVersion("gpt-5.6-sol")).toEqual({ major: 5, minor: 6 })
    expect(parseGptVersion("gpt-5")).toEqual({ major: 5, minor: 0 })
    expect(parseGptVersion("o3")).toBeNull()
    expect(parseGptVersion("claude-sonnet-4")).toBeNull()
    expect(parseGptVersion(undefined)).toBeNull()
  })

  test("version comparison for ≥ 5.4 gate", () => {
    expect(isGptVersionAtLeast("gpt-5.4", 5, 4)).toBe(true)
    expect(isGptVersionAtLeast("gpt-5.4-mini", 5, 4)).toBe(true)
    expect(isGptVersionAtLeast("gpt-5.5", 5, 4)).toBe(true)
    expect(isGptVersionAtLeast("gpt-5.6-terra", 5, 4)).toBe(true)
    expect(isGptVersionAtLeast("gpt-5.3-codex-spark", 5, 4)).toBe(false)
    expect(isGptVersionAtLeast("gpt-5", 5, 4)).toBe(false)
    expect(isGptVersionAtLeast("gpt-4.1", 5, 4)).toBe(false)
    expect(isGptVersionAtLeast("glm-5.2", 5, 4)).toBe(false)
  })
})

describe("supportsNativeToolSearch gate", () => {
  test("codex + GPT ≥ 5.4 only", () => {
    expect(supportsNativeToolSearch("codex", "gpt-5.4")).toBe(true)
    expect(supportsNativeToolSearch("codex", "gpt-5.4-mini")).toBe(true)
    expect(supportsNativeToolSearch("codex", "gpt-5.5")).toBe(true)
    expect(supportsNativeToolSearch("codex", "gpt-5.6-sol")).toBe(true)
  })

  test("rejects wrong provider even with eligible model", () => {
    expect(supportsNativeToolSearch("zen", "gpt-5.5")).toBe(false)
    expect(supportsNativeToolSearch("grok", "gpt-5.4")).toBe(false)
    expect(supportsNativeToolSearch("anthropic", "gpt-5.5")).toBe(false)
  })

  test("rejects codex with pre-5.4 GPT or non-GPT", () => {
    expect(supportsNativeToolSearch("codex", "gpt-5.3-codex-spark")).toBe(false)
    expect(supportsNativeToolSearch("codex", "gpt-5")).toBe(false)
    expect(supportsNativeToolSearch("codex", "o3")).toBe(false)
    expect(supportsNativeToolSearch("codex", undefined)).toBe(false)
  })
})

describe("core / deferred partition", () => {
  test("CORE_TOOL_NAMES covers filesystem/edit + skills", () => {
    for (const name of [
      "read",
      "bash",
      "fffind",
      "ffgrep",
      "write",
      "edit",
      "apply_patch",
      "search_skills",
      "load_skill",
    ]) {
      expect(isCoreToolName(name)).toBe(true)
      expect(CORE_TOOL_NAMES).toContain(name as (typeof CORE_TOOL_NAMES)[number])
    }
    expect(isCoreToolName("spawn_thread")).toBe(false)
    expect(isCoreToolName("workflow")).toBe(false)
    expect(isCoreToolName("advisor")).toBe(false)
    expect(isCoreToolName("manage_models")).toBe(false)
  })

  test("partitionTools splits by name", () => {
    const tools = [
      { name: "read" },
      { name: "spawn_thread" },
      { name: "search_skills" },
      { name: "workflow" },
      { name: "load_skill" },
    ]
    const { core, deferred } = partitionTools(tools)
    expect(core.map((t) => t.name)).toEqual(["read", "search_skills", "load_skill"])
    expect(deferred.map((t) => t.name)).toEqual(["spawn_thread", "workflow"])
    expect(deferredToolNames(tools)).toEqual(["spawn_thread", "workflow"])
  })

  test("real executor tools: core kept, non-core deferred under gate", () => {
    const { tools } = executorToolsFor({ provider: "codex", model: "gpt-5.5" })
    const names = tools.map((t) => t.name)
    expect(names).toContain("read")
    expect(names).toContain("search_skills")
    expect(names).toContain("load_skill")
    expect(names).toContain("apply_patch") // codex family edit tool
    expect(names).toContain("spawn_thread")
    expect(names).toContain("workflow")

    const { core, deferred } = partitionTools(tools)
    expect(core.every((t) => isCoreToolName(t.name))).toBe(true)
    expect(deferred.every((t) => !isCoreToolName(t.name))).toBe(true)
    expect(core.map((t) => t.name)).toContain("search_skills")
    expect(core.map((t) => t.name)).toContain("load_skill")
    expect(deferred.map((t) => t.name)).toContain("spawn_thread")
    expect(deferred.map((t) => t.name)).not.toContain("read")
  })
})

describe("middleware inclusion configuration", () => {
  test("codex + gpt-5.5 yields searchableTools config with deferred names only", () => {
    const { tools } = executorToolsFor({ provider: "codex", model: "gpt-5.5" })
    const config = toolSearchMiddlewareConfigFor("codex", "gpt-5.5", tools)
    expect(config).not.toBeNull()
    expect(config!.searchableTools.length).toBeGreaterThan(0)
    for (const name of config!.searchableTools) {
      expect(isCoreToolName(name)).toBe(false)
    }
    expect(config!.searchableTools).toContain("spawn_thread")
    expect(config!.searchableTools).not.toContain("read")
    expect(config!.searchableTools).not.toContain("search_skills")
    expect(config!.searchableTools).not.toContain("load_skill")
  })

  test("unsupported provider/model: null config and null middleware (safe fallback)", () => {
    const { tools } = executorToolsFor({ provider: "zen", model: "glm-5.2" })
    expect(toolSearchMiddlewareConfigFor("zen", "glm-5.2", tools)).toBeNull()
    expect(buildToolSearchMiddleware("zen", "glm-5.2", tools)).toBeNull()

    // codex but pre-5.4
    expect(toolSearchMiddlewareConfigFor("codex", "gpt-5.3-codex-spark", tools)).toBeNull()
    expect(buildToolSearchMiddleware("codex", "gpt-5.3-codex-spark", tools)).toBeNull()
  })

  test("buildToolSearchMiddleware returns middleware instance when gated on", () => {
    const { tools } = executorToolsFor({ provider: "codex", model: "gpt-5.4" })
    const mw = buildToolSearchMiddleware("codex", "gpt-5.4", tools)
    expect(mw).not.toBeNull()
    // LangChain middleware brand / name
    expect((mw as { name?: string }).name).toBe("ProviderToolSearch")
  })

  test("agentPlanFor mirrors gate + config", () => {
    const on = agentPlanFor({ provider: "codex", model: "gpt-5.5" })
    expect(on.nativeToolSearch).toBe(true)
    expect(on.toolSearchConfig).not.toBeNull()
    expect(on.toolSearchConfig!.searchableTools).toContain("workflow")
    expect(on.editToolName).toBe("apply_patch")

    const off = agentPlanFor({ provider: "zen", model: "glm-5.2" })
    expect(off.nativeToolSearch).toBe(false)
    expect(off.toolSearchConfig).toBeNull()
    expect(off.editToolName).toBe("edit")
  })
})

describe("portable deferred tool search", () => {
  test("Grok binds core tools plus compact search and dispatch tools", () => {
    const { tools } = executorToolsFor({ provider: "grok", model: "grok-4.5" })
    const bound = portableToolSetFor("grok", tools)
    const names = bound.map((tool) => tool.name)

    expect(names).toContain("read")
    expect(names).toContain("edit")
    expect(names).toContain("search_skills")
    expect(names).toContain("search_tools")
    expect(names).toContain("call_deferred_tool")
    expect(names).not.toContain("workflow")
    expect(names).not.toContain("spawn_thread")
    expect(names).not.toContain("advisor")
  })

  test("other providers keep their original bound tool set", () => {
    const { tools } = executorToolsFor({ provider: "zen", model: "glm-5.2" })
    expect(portableToolSetFor("zen", tools)).toBe(tools)
  })

  test("search exposes a deferred schema and dispatch executes the original tool", async () => {
    const core = tool(async () => "read", {
      name: "read",
      description: "Read a file",
      schema: z.object({ path: z.string() }),
    })
    const deferred = tool(async ({ value }: { value: string }) => `ran:${value}`, {
      name: "workflow",
      description: "Run a parallel workflow",
      schema: z.object({ value: z.string() }),
    })
    const bound = portableToolSetFor("grok", [core, deferred])
    const search = bound.find((item) => item.name === "search_tools")!
    const dispatch = bound.find((item) => item.name === "call_deferred_tool")!

    const matches = JSON.parse(String(await search.invoke({ query: "parallel" })))
    expect(matches).toHaveLength(1)
    expect(matches[0].name).toBe("workflow")
    expect(matches[0].input_schema.type).toBe("object")
    expect(matches[0].input_schema.properties.value.type).toBe("string")
    expect(await dispatch.invoke({ name: "workflow", arguments: { value: "ok" } })).toBe("ran:ok")
  })
})

describe("system prompt does not falsely enumerate deferred tools in native mode", () => {
  test("native mode lists core only; omits deferred tool names", () => {
    const prompt = buildSystemPrompt("apply_patch", true, "/tmp/ws", { nativeToolSearch: true })
    expect(prompt).toContain("read:")
    expect(prompt).toContain("bash:")
    expect(prompt).toContain("search_skills")
    expect(prompt).toContain("load_skill")
    expect(prompt).toContain("apply_patch")
    // Deferred tools must not appear as enumerated list entries
    expect(prompt).not.toMatch(/^- spawn_thread:/m)
    expect(prompt).not.toMatch(/^- workflow:/m)
    expect(prompt).not.toMatch(/^- ship_goal:/m)
    expect(prompt).not.toMatch(/^- list_sessions/m)
    expect(prompt).not.toMatch(/^- get_goal/m)
    expect(prompt).not.toMatch(/^- manage_models/m)
    expect(prompt).not.toMatch(/^- advisor:/m)
    expect(prompt).toContain("tool search")
  })

  test("fallback mode still enumerates full tool catalog (no regression)", () => {
    const prompt = buildSystemPrompt("edit", true, "/tmp/ws", { nativeToolSearch: false })
    expect(prompt).toContain("spawn_thread:")
    expect(prompt).toContain("workflow:")
    expect(prompt).toContain("ship_goal:")
    expect(prompt).toContain("list_sessions")
    expect(prompt).toContain("get_goal")
    expect(prompt).toContain("search_skills")
    expect(prompt).toContain("advisor:")
  })
})
