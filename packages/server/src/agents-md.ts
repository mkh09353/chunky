import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import type { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { repoId, stateDir } from "./repos.ts"
import { resolveModel, sidekickFor, type AgentSelection } from "./providers/registry.ts"

const MAX_BYTES = 32 * 1024
const DISTILL_SYSTEM = "Extract only actionable repository rules from the supplied instructions. Output terse plain bullet text, or exactly NONE if there is nothing actionable. Keep only: commands to run/build/test locally, commit/PR rules, security constraints, and non-obvious gotchas. Drop architecture tours, directory maps, and style philosophy."

type Invoke = (model: BaseChatModel, messages: Array<{ role: "system" | "user"; content: string }>) => Promise<unknown>
let invokeModel: Invoke = async (model, messages) => model.invoke(messages)

/** Test seam for the deliberately one-shot, no-tools distillation call. */
export function setAgentsMdInvokerForTests(invoker: Invoke | null): void {
  invokeModel = invoker ?? (async (model, messages) => model.invoke(messages))
}

function textOf(value: unknown): string {
  const content = (value as { content?: unknown })?.content
  if (typeof content === "string") return content
  if (Array.isArray(content)) return content.map((x) => typeof x === "string" ? x : (x as any)?.text ?? "").join("")
  return typeof value === "string" ? value : ""
}

export async function distilledAgentsMd(workspace: string, selection: AgentSelection): Promise<string | null> {
  try {
    const root = resolve(workspace)
    const sourcePath = [join(root, "AGENTS.md"), join(root, "CLAUDE.md")].find(existsSync)
    if (!sourcePath) return null
    const raw = readFileSync(sourcePath).subarray(0, MAX_BYTES).toString("utf8")
    const sourceHash = createHash("sha256").update(raw).digest("hex")
    const cachePath = join(stateDir(), "agents-md", `${repoId(root)}.json`)
    try {
      const cached = JSON.parse(readFileSync(cachePath, "utf8")) as { sourceHash?: string; distilled?: string }
      if (cached.sourceHash === sourceHash) return cached.distilled?.trim() || null
    } catch { /* cache miss */ }

    // Distill with the sidekick model when configured; a disabled sidekick
    // just means we fall back to the lead selection for this one-shot call.
    const sidekickSelection = sidekickFor(selection) ?? selection
    const result = await invokeModel(resolveModel(sidekickSelection), [
      { role: "system", content: DISTILL_SYSTEM },
      { role: "user", content: raw },
    ])
    const distilled = textOf(result).trim()
    const useful = distilled === "NONE" ? "" : distilled
    mkdirSync(join(stateDir(), "agents-md"), { recursive: true })
    writeFileSync(cachePath, JSON.stringify({ sourcePath, sourceHash, distilled: useful, model: `${sidekickSelection.provider}/${sidekickSelection.model}`, createdAt: Date.now() }, null, 2))
    return useful || null
  } catch (err) {
    console.warn(`[@chunky/server] could not distill AGENTS.md: ${(err as Error)?.message ?? String(err)}`)
    return null
  }
}
