// Permanent compact tools for lazy on-demand Agent Skills.
// Bodies never enter the system prompt — only search metadata + explicit loads.
import { tool } from "@langchain/core/tools"
import { z } from "zod"
import {
  formatLoadResult,
  formatSearchResults,
  loadSkill,
  searchSkills,
} from "../skills.ts"
import { sessionForThread } from "../thread-context.ts"
import { workspaceFromConfig } from "../workspace.ts"

function scopeKeyFromConfig(config: unknown): string {
  const threadId = (config as { configurable?: { thread_id?: string } } | undefined)
    ?.configurable?.thread_id
  if (threadId) {
    // Prefer session scope so sibling threads share "already loaded" state.
    const sessionId = sessionForThread(threadId)
    return sessionId ?? threadId
  }
  return "default"
}

export const searchSkillsInputShape = {
  query: z
    .string()
    .optional()
    .describe(
      "Optional keyword filter over skill name/description (space-separated tokens are AND). Omit to list all discovered skills.",
    ),
}

export const searchSkillsTool = tool(
  async ({ query }: { query?: string }, config?: unknown) => {
    const workspace = workspaceFromConfig(config)
    const skills = searchSkills(workspace, query)
    return formatSearchResults(skills, query)
  },
  {
    name: "search_skills",
    description:
      "Discover available Agent Skills (SKILL.md packages) from user and project locations. " +
      "Returns names and short descriptions only — not skill bodies. Call this when a task might " +
      "match a specialized workflow; then load_skill for the full instructions. Skills are never auto-loaded.",
    schema: z.object(searchSkillsInputShape),
  },
)

export const loadSkillInputShape = {
  name: z
    .string()
    .describe("Skill name from search_skills (exact name preferred; unique prefix accepted)."),
}

export const loadSkillTool = tool(
  async ({ name }: { name: string }, config?: unknown) => {
    const workspace = workspaceFromConfig(config)
    const scopeKey = scopeKeyFromConfig(config)
    const result = loadSkill(workspace, name, scopeKey)
    if ("error" in result) return `error: ${result.error}`
    return formatLoadResult(result)
  },
  {
    name: "load_skill",
    description:
      "Load a skill's full SKILL.md instructions into this turn as tool output. " +
      "Use after search_skills when a skill's description matches the task. " +
      "Repeat loads re-emit the full body (safe after compaction). Skill bodies are never in the system prompt.",
    schema: z.object(loadSkillInputShape),
  },
)

export const skillTools = [searchSkillsTool, loadSkillTool]
