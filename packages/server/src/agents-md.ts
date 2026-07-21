import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import type { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { repoId, stateDir } from "./repos.ts"
import { resolveModel, sidekickFor, type AgentSelection } from "./providers/registry.ts"
import { agentsMdEnabled } from "./settings.ts"
import { assertSelectionAllowed, isIncognitoSession } from "./incognito.ts"

const DISTILL_SYSTEM = "Extract only actionable repository rules from the supplied instructions. Output terse plain bullet text, or exactly NONE if there is nothing actionable. Keep only: commands to run/build/test locally, commit/PR rules, security constraints, and non-obvious gotchas. Drop architecture tours, directory maps, and style philosophy."

type Invoke = (model: BaseChatModel, messages: Array<{ role: "system" | "user"; content: string }>) => Promise<unknown>
let invokeModel: Invoke = async (model, messages) => model.invoke(messages)

/** Test seam for the deliberately one-shot, no-tools distillation call. */
export function setAgentsMdInvokerForTests(invoker: Invoke | null): void {
  invokeModel = invoker ?? (async (model, messages) => model.invoke(messages))
}

/** Find the git root, without ever walking above the repository boundary. A
 * non-git temporary workspace is its own boundary (also useful to embedders). */
function repositoryRoot(workspace: string): string {
  let dir = realpathSync(resolve(workspace))
  while (true) {
    if (existsSync(join(dir, ".git"))) return dir
    const parent = dirname(dir)
    if (parent === dir) return realpathSync(resolve(workspace))
    dir = parent
  }
}

function instructionSources(workspace: string): { root: string; paths: string[] } {
  const current = realpathSync(resolve(workspace))
  const root = repositoryRoot(current)
  const dirs: string[] = []
  let dir = current
  while (true) {
    dirs.unshift(dir)
    if (dir === root) break
    const parent = dirname(dir)
    dir = parent
  }
  const paths: string[] = []
  for (const folder of dirs) {
    // AGENTS.md wins over CLAUDE.md in each directory, preserving the existing
    // precedence while allowing repository-root instructions for nested runs.
    const agents = join(folder, "AGENTS.md")
    const claude = join(folder, "CLAUDE.md")
    if (existsSync(agents)) paths.push(agents)
    else if (existsSync(claude)) paths.push(claude)
  }
  return { root, paths }
}

function textOf(value: unknown): string {
  const content = (value as { content?: unknown })?.content
  if (typeof content === "string") return content
  if (Array.isArray(content)) return content.map((x) => typeof x === "string" ? x : (x as any)?.text ?? "").join("")
  return typeof value === "string" ? value : ""
}

export async function distilledAgentsMd(workspace: string, selection: AgentSelection, sessionId?: string): Promise<string | null> {
  assertSelectionAllowed(sessionId ?? null, selection)
  try {
    const { root, paths } = instructionSources(workspace)
    const repoKey = repoId(root)
    if (!agentsMdEnabled(repoKey)) return null
    if (paths.length === 0) return null
    const sources = paths.map((path) => ({ path, content: readFileSync(path, "utf8") }))
    const sourceHash = createHash("sha256")
      .update(JSON.stringify(sources))
      .digest("hex")
    const modelSelection = sidekickFor(selection) ?? selection
    const model = `${modelSelection.provider}/${modelSelection.model}`
    const cachePath = join(stateDir(), "agents-md", `${repoId(root)}.json`)
    try {
      const cached = JSON.parse(readFileSync(cachePath, "utf8")) as { sourceHash?: string; distilled?: string; model?: string; enabled?: boolean }
      if (cached.sourceHash === sourceHash && cached.model === model && cached.enabled === true) return cached.distilled?.trim() || null
    } catch { /* cache miss */ }

    // Distill with the sidekick model when configured; a disabled sidekick
    // just means we fall back to the lead selection for this one-shot call.
    const result = await invokeModel(resolveModel(modelSelection, sessionId), [
      { role: "system", content: DISTILL_SYSTEM },
      { role: "user", content: sources.map((s) => `<!-- ${relative(root, s.path)} -->\n${s.content}`).join("\n\n") },
    ])
    const distilled = textOf(result).trim()
    const useful = distilled === "NONE" ? "" : distilled
    mkdirSync(join(stateDir(), "agents-md"), { recursive: true })
    if (!isIncognitoSession(sessionId ?? "")) writeFileSync(cachePath, JSON.stringify({ sourcePaths: paths, sourceHash, distilled: useful, model, enabled: true, createdAt: Date.now() }, null, 2))
    return useful || null
  } catch (err) {
    console.warn(`[@chunky/server] could not distill AGENTS.md: ${(err as Error)?.message ?? String(err)}`)
    return null
  }
}
