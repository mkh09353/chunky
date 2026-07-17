// NOTICE: Derived from xai-org/grok-build xai-codebase-graph, Apache-2.0.
import { tool } from "@langchain/core/tools"
import { z } from "zod"
import { getCodegraph, type Hit } from "../codegraph/index.ts"
import { workspaceFromConfig } from "../workspace.ts"

const input = z.object({ file: z.string().optional(), line: z.number().int().positive().optional(), col: z.number().int().positive().optional(), symbol: z.string().optional(), context_file: z.string().optional(), include_definition: z.boolean().optional() }).refine(x => x.symbol || (x.file && x.line && x.col), "provide symbol or file, line, and col")
function format(hits: Hit[], root: string) {
  if (!hits.length) return "No indexed codegraph results (the language may be unsupported or the workspace is not indexed)."
  return hits.map(h => `${h.file.startsWith(root) ? h.file.slice(root.length + 1) : h.file}:${h.line}${h.matchedSymbol ? ` (${h.matchedSymbol})` : ""}`).join("\n")
}
async function run(args: z.infer<typeof input>, config: unknown, refs: boolean) {
  try { const root = workspaceFromConfig(config); const m = getCodegraph(root); const hits = args.symbol ? await m.query(args.symbol, refs, args.context_file, args.include_definition ?? true) : await m.at(args.file!, args.line!, args.col!, refs, args.context_file, args.include_definition ?? true); return format(hits, root) } catch (e) { return `Codegraph unavailable: ${e instanceof Error ? e.message : String(e)}` }
}
export const goto_definition = tool((a, c) => run(a, c, false), { name: "goto_definition", description: "Find symbol definitions. Prefer this over ffgrep for symbol lookup.", schema: input })
export const find_references = tool((a, c) => run(a, c, true), { name: "find_references", description: "Find references to a symbol. Prefer this over ffgrep for symbol lookup.", schema: input })
