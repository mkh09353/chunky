// Native provider tool search (OpenAI Responses `tool_search` via LangChain's
// providerToolSearchMiddleware). Gated strictly to Codex + GPT ≥ 5.4 so other
// providers/models keep the full always-bound tool catalog as a safe fallback.
//
// Core tools stay eagerly available (filesystem/edit + skill discovery/load).
// Everything else is deferred/searchable when the gate is on.
import { providerToolSearchMiddleware } from "langchain"
import { tool, type StructuredToolInterface } from "@langchain/core/tools"
import { z } from "zod"

/** Essential tools that must remain bound (not deferred) under native tool search. */
export const CORE_TOOL_NAMES = Object.freeze([
  "read",
  "bash",
  "fffind",
  "ffgrep",
  "goto_definition",
  "find_references",
  "write",
  "edit",
  "apply_patch",
  // The sidekick is the DEFAULT delegation path (the main flow), so it must be
  // eagerly bound — a deferred workhorse would push models back toward whatever
  // delegation tool happens to be visible.
  "sidekick",
  "search_skills",
  "load_skill",
  "update_todos",
] as const)

const CORE_TOOL_NAME_SET = new Set<string>(CORE_TOOL_NAMES)

export type ToolLike = { name: string }

/**
 * Parse a GPT family version from a model id (`gpt-5.4`, `gpt-5.4-mini`,
 * `gpt-5.6-sol`, …). Returns null when the id is not a gpt-X[.Y] model.
 */
export function parseGptVersion(
  modelId: string | undefined,
): { major: number; minor: number } | null {
  const id = (modelId ?? "").toLowerCase()
  const m = id.match(/(?:^|[^a-z0-9])gpt-(\d+)(?:\.(\d+))?/)
  if (!m) return null
  return {
    major: Number(m[1]),
    minor: m[2] !== undefined ? Number(m[2]) : 0,
  }
}

/** True when model id is GPT family with version ≥ minMajor.minMinor. */
export function isGptVersionAtLeast(
  modelId: string | undefined,
  minMajor: number,
  minMinor: number,
): boolean {
  const v = parseGptVersion(modelId)
  if (!v) return false
  if (v.major > minMajor) return true
  if (v.major < minMajor) return false
  return v.minor >= minMinor
}

/**
 * Whether this selection may use OpenAI Responses native tool search.
 * Strict gate: provider must be `codex` AND model must be GPT ≥ 5.4 family.
 */
export function supportsNativeToolSearch(
  provider: string,
  modelId: string | undefined,
): boolean {
  return provider === "codex" && isGptVersionAtLeast(modelId, 5, 4)
}

export function isCoreToolName(name: string): boolean {
  return CORE_TOOL_NAME_SET.has(name)
}

/** Partition tools into always-on core vs deferred (searchable) non-core. */
export function partitionTools<T extends ToolLike>(tools: readonly T[]): {
  core: T[]
  deferred: T[]
} {
  const core: T[] = []
  const deferred: T[] = []
  for (const t of tools) {
    if (isCoreToolName(t.name)) core.push(t)
    else deferred.push(t)
  }
  return { core, deferred }
}

/** Names of tools that should be marked searchable/deferred under native mode. */
export function deferredToolNames(tools: readonly ToolLike[]): string[] {
  return partitionTools(tools).deferred.map((t) => t.name)
}

/** Grok has Responses function calling but not OpenAI's server-side tool_search. */
export function supportsPortableToolSearch(provider: string): boolean {
  return provider === "grok"
}

/**
 * Provider-neutral deferred tools for Grok. Only core schemas plus these two
 * compact meta-tools are sent up front; search returns matching deferred tool
 * contracts and dispatch invokes one of the original LangChain tools locally.
 */
export function portableToolSetFor<T extends StructuredToolInterface>(
  provider: string,
  tools: T[],
): StructuredToolInterface[] {
  if (!supportsPortableToolSearch(provider)) return tools

  const { core, deferred } = partitionTools(tools)
  const byName = new Map(deferred.map((item) => [item.name, item]))
  const searchTools = tool(
    async ({ query }: { query: string }) => {
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
      const matches = deferred
        .map((item) => {
          const haystack = `${item.name} ${item.description ?? ""}`.toLowerCase()
          const score = terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0)
          return { item, score }
        })
        .filter(({ score }) => terms.length === 0 || score > 0)
        .sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name))
        .slice(0, 8)
        .map(({ item }) => ({
          name: item.name,
          description: item.description,
          input_schema: z.toJSONSchema(item.schema as z.ZodType),
        }))
      return JSON.stringify(matches)
    },
    {
      name: "search_tools",
      description: "Search deferred tools by capability. Returns names, descriptions, and input schemas for matching tools.",
      schema: z.object({ query: z.string().describe("Short capability query, such as workflow, sessions, goals, or models.") }),
    },
  )
  const callDeferredTool = tool(
    async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }, config) => {
      const target = byName.get(name)
      if (!target) return `error: unknown deferred tool ${JSON.stringify(name)}; call search_tools first.`
      return target.invoke(args, config)
    },
    {
      name: "call_deferred_tool",
      description: "Invoke a deferred tool discovered with search_tools using its exact name and schema-compliant arguments.",
      schema: z.object({
        name: z.string().describe("Exact deferred tool name returned by search_tools."),
        arguments: z.record(z.string(), z.unknown()).describe("Arguments matching the discovered input_schema."),
      }),
    },
  )

  return [...core, searchTools, callDeferredTool]
}

/**
 * Build providerToolSearchMiddleware config when the gate is open and there is
 * at least one deferred tool; otherwise null (caller keeps full always-bound set).
 */
export function toolSearchMiddlewareConfigFor(
  provider: string,
  modelId: string | undefined,
  tools: readonly ToolLike[],
): { searchableTools: string[] } | null {
  if (!supportsNativeToolSearch(provider, modelId)) return null
  const searchableTools = deferredToolNames(tools)
  if (searchableTools.length === 0) return null
  return { searchableTools }
}

/**
 * Instantiated middleware for createAgent, or null when tool search is off
 * (unsupported provider/model — preserve existing behavior, no deferral).
 */
export function buildToolSearchMiddleware(
  provider: string,
  modelId: string | undefined,
  tools: readonly ToolLike[],
): ReturnType<typeof providerToolSearchMiddleware> | null {
  const config = toolSearchMiddlewareConfigFor(provider, modelId, tools)
  if (!config) return null
  return providerToolSearchMiddleware({
    searchableTools: config.searchableTools as Array<string | StructuredToolInterface>,
  })
}
