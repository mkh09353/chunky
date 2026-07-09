// Agent wiring. The model comes from the provider registry (resolveModel), and
// agent construction is a factory (buildAgent) so the threads work can rebuild
// it with subagents. Durable state via a SQLite checkpointer.
import { readdirSync } from "node:fs"
import { tool } from "@langchain/core/tools"
import { z } from "zod"
import { createDeepAgent } from "deepagents"
import { resolveModel } from "./providers/registry.ts"

// ONE trivial custom tool: list the entries of a directory (defaults to ".").
const listDir = tool(
  async ({ path }: { path?: string }) => {
    const dir = path && path.length > 0 ? path : "."
    try {
      const entries = readdirSync(dir)
      return entries.length ? entries.join("\n") : "(empty directory)"
    } catch (err) {
      return `error: ${(err as Error).message}`
    }
  },
  {
    name: "list_dir",
    description:
      "List the names of files and folders in a directory on the server. Defaults to the current working directory.",
    schema: z.object({
      path: z.string().optional().describe("Directory path to list. Defaults to '.' (current directory)."),
    }),
  },
)

/**
 * Durable checkpointer so agent memory survives a restart. Uses a SEPARATE
 * sqlite file from the session store to avoid cross-library write contention.
 * Falls back to in-memory if the sqlite saver can't load in this runtime.
 */
function makeCheckpointer() {
  try {
    // Lazy require so a load failure degrades gracefully instead of crashing boot.
    const { SqliteSaver } = require("@langchain/langgraph-checkpoint-sqlite")
    return SqliteSaver.fromConnString(process.env.MC_GRAPH_DB || "multicode-graph.db")
  } catch (err) {
    const { MemorySaver } = require("@langchain/langgraph")
    console.warn(`[@mc/server] durable checkpointer unavailable (${(err as Error).message}); using in-memory`)
    return new MemorySaver()
  }
}

export interface BuildAgentOpts {
  // The threads work fills this in (subagent roster for real nested threads).
  subagents?: unknown[]
}

/** Build the DeepAgents agent for the active provider. */
export function buildAgent(opts: BuildAgentOpts = {}) {
  return createDeepAgent({
    model: resolveModel(),
    tools: [listDir],
    checkpointer: makeCheckpointer(),
    ...(opts.subagents ? ({ subagents: opts.subagents } as Record<string, unknown>) : {}),
  })
}

// Default singleton used by run.ts.
export const agent = buildAgent()
