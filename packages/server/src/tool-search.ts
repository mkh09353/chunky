// Native provider tool search (OpenAI Responses `tool_search` via LangChain's
// providerToolSearchMiddleware). Gated strictly to Codex + GPT ≥ 5.4 so other
// providers/models keep the full always-bound tool catalog as a safe fallback.
//
// Core tools stay eagerly available (filesystem/edit + skill discovery/load).
// Everything else is deferred/searchable when the gate is on.
import { providerToolSearchMiddleware } from "langchain"
import type { StructuredToolInterface } from "@langchain/core/tools"

/** Essential tools that must remain bound (not deferred) under native tool search. */
export const CORE_TOOL_NAMES = Object.freeze([
  "read",
  "bash",
  "fffind",
  "ffgrep",
  "write",
  "edit",
  "apply_patch",
  "search_skills",
  "load_skill",
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
