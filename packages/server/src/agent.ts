// Agent wiring. The model comes from the provider registry (resolveModel), and
// agent construction is a factory (buildAgent) so the threads work can rebuild
// it per provider. Durable state via a SQLite checkpointer. Filesystem tools
// (read_file/write_file/edit_file/ls/glob/grep) are backed by a REAL
// disk-backed FilesystemBackend rooted at WORKSPACE — not the in-memory
// StateBackend DeepAgents defaults to — so agent edits land on disk.
import { tool } from "@langchain/core/tools"
import { z } from "zod"
import { createDeepAgent, FilesystemBackend } from "deepagents"
import { activeProviderId, resolveModel, selectionOf, selectionSignature } from "./providers/registry.ts"
import { threadContextFor } from "./thread-context.ts"
import { applyPatch } from "./tools/apply-patch.ts"
import { WORKSPACE } from "./workspace.ts"

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

/** True for OpenAI's GPT/Codex model family — the models trained on the V4A
 *  `apply_patch` tool. Matches on provider id ("codex" is the ChatGPT/Codex
 *  OAuth provider) OR on the model id itself (a "gpt"/"codex" model served
 *  through another OpenAI-compatible provider, e.g. Zen). */
function isGptCodexFamily(modelId: string | undefined, providerId: string): boolean {
  if (providerId === "codex") return true
  const id = (modelId ?? "").toLowerCase()
  return id.includes("gpt") || id.includes("codex")
}

/**
 * Pick the edit tool(s) for the active model. GPT/Codex models are trained
 * on the V4A `apply_patch` format, so they get that tool; Claude and other
 * models keep DeepAgents' built-in `edit_file` (from the filesystem
 * middleware — see buildAgent's `backend`). We can't cleanly remove just
 * `edit_file` from the filesystem middleware's built-in tool set, so it
 * stays available to every model; gpt/codex models additionally get
 * `apply_patch`, which they strongly prefer (it's the format they were
 * trained on) over the generic `edit_file`.
 */
export function editToolsForModel(modelId: string | undefined, providerId: string) {
  return isGptCodexFamily(modelId, providerId) ? [applyPatch] : []
}

/** Build the DeepAgents agent for the active provider. Filesystem tools are
 *  backed by a real disk-backed FilesystemBackend rooted at WORKSPACE
 *  (replacing DeepAgents' default in-memory StateBackend), so read_file /
 *  write_file / edit_file / ls / glob / grep operate on the real project
 *  directory and edits land on disk. */
export function buildAgent(opts: BuildAgentOpts = {}) {
  const providerId = activeProviderId()
  const modelId = selectionOf(providerId).model
  return createDeepAgent({
    model: resolveModel(),
    tools: [spawnThread, ...editToolsForModel(modelId, providerId)],
    backend: new FilesystemBackend({ rootDir: WORKSPACE, virtualMode: true }),
    checkpointer: makeCheckpointer(),
    ...(opts.subagents ? ({ subagents: opts.subagents } as Record<string, unknown>) : {}),
  })
}

// Default singleton, kept for compatibility. It pins the boot-time provider's
// model; getAgent() lets a run pick up a provider switch without a restart.
export const agent = buildAgent()

// Cache one agent per full SELECTION signature (provider + model + effort +
// speed) so switching provider, model, OR a reasoning knob rebuilds the model,
// while an unchanged selection reuses its agent (keeping live thread state). The
// durable sqlite checkpointer is keyed by thread_id, so even a rebuilt agent
// resumes prior memory from disk.
const agentCache = new Map<string, ReturnType<typeof buildAgent>>([[selectionSignature(), agent]])

/** The agent for the current selection, rebuilt on first use per signature. */
export function getAgent(): ReturnType<typeof buildAgent> {
  const sig = selectionSignature()
  let a = agentCache.get(sig)
  if (!a) {
    a = buildAgent()
    agentCache.set(sig, a)
  }
  return a
}

/** Drop cached agents so the next getAgent() rebuilds for the current selection.
 *  The /api/model/select route calls this after persisting a new selection. */
export function invalidateAgent(): void {
  agentCache.clear()
}
