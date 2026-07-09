// Agent wiring. The model comes from the provider registry (resolveModel), and
// agent construction is a factory (buildAgent) so the threads work can rebuild
// it per provider. Durable state via a SQLite checkpointer.
import { readdirSync } from "node:fs"
import { tool } from "@langchain/core/tools"
import { z } from "zod"
import { createDeepAgent } from "deepagents"
import { resolveModel, activeProviderId } from "./providers/registry.ts"
import { threadContextFor } from "./thread-context.ts"

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
 * spawn_thread — delegate a subtask to a FULL, independent child agent thread.
 * Unlike a hidden subagent blob, the child is its own streamable agent run (its
 * own LangGraph thread_id) whose activity streams live to the UI, tagged with the
 * child's threadId. The child agent also has this tool, so it can spawn its own
 * children (recursion). Returns the child thread's final answer to the caller.
 *
 * The RunnableConfig (2nd arg) carries `configurable.thread_id` — the id of the
 * thread whose model invoked this tool — which we use to find the active run's
 * ThreadManager and to nest the child under the correct parent.
 */
const spawnThread = tool(
  async ({ title, instructions }: { title: string; instructions: string }, config?: unknown) => {
    const callerThreadId = (config as any)?.configurable?.thread_id as string | undefined
    const ctx = threadContextFor(callerThreadId)
    if (!ctx || !callerThreadId) {
      return "error: spawn_thread is only available inside an active session run."
    }
    const text = await ctx.spawn({ callerThreadId, title, instructions })
    return `Child thread "${title}" finished.\n\n${text}`
  },
  {
    name: "spawn_thread",
    description:
      "Delegate a focused subtask to a full, independent child agent thread that streams its own work live. " +
      "Use it to isolate or parallelize a subtask; the child is a real agent that can itself spawn further child " +
      "threads. Returns the child thread's final answer.",
    schema: z.object({
      title: z
        .string()
        .describe("Short title for the child thread, shown in the UI (e.g. 'List project files')."),
      instructions: z
        .string()
        .describe("The full task/instructions to hand to the child agent thread."),
    }),
  },
)

/**
 * Durable checkpointer so agent memory survives a restart, backed by bun:sqlite
 * (the official saver uses better-sqlite3, which Bun can't load). Uses a SEPARATE
 * sqlite file from the session store to avoid cross-connection write contention.
 * Falls back to in-memory only if the bun:sqlite saver can't initialize.
 */
function makeCheckpointer() {
  try {
    const { BunSqliteSaver } = require("./bun-sqlite-saver.ts")
    return BunSqliteSaver.fromConnString(process.env.MC_GRAPH_DB || "multicode-graph.db")
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
    tools: [listDir, spawnThread],
    checkpointer: makeCheckpointer(),
    ...(opts.subagents ? ({ subagents: opts.subagents } as Record<string, unknown>) : {}),
  })
}

// Default singleton, kept for compatibility. It pins the boot-time provider's
// model; getAgent() lets a run pick up a provider switch without a restart.
export const agent = buildAgent()

// Cache one agent per provider id so switching providers rebuilds the model
// (addressing the boot-pin caveat) while a given provider keeps ONE agent — and
// therefore one checkpointer — so its thread memory is preserved across turns.
const agentCache = new Map<string, ReturnType<typeof buildAgent>>([[activeProviderId(), agent]])

/** The agent for the currently-active provider, rebuilt on first use per provider. */
export function getAgent(): ReturnType<typeof buildAgent> {
  const id = activeProviderId()
  let a = agentCache.get(id)
  if (!a) {
    a = buildAgent()
    agentCache.set(id, a)
  }
  return a
}
