// Agent wiring. The model comes from the provider registry (resolveModel), and
// agent construction is a factory (buildAgent) so the threads work can rebuild
// it per provider. Durable state via a SQLite checkpointer.
//
// LEAN HARNESS: we call `createAgent` from `langchain` directly — the same
// primitive `createDeepAgent` wraps — instead of `createDeepAgent`. This sheds
// DeepAgents' heavy defaults (BASE_AGENT_PROMPT, write_todos, the 6 verbose
// filesystem tools, the `task` tool) and replaces them with our own ~300-token
// system prompt and four lean tools (read/bash/write/edit) that operate directly
// on WORKSPACE via node:fs. Checkpointer, streaming, threads, and providers are
// all unchanged — only the agent-construction call differs.
import { tool } from "@langchain/core/tools"
import { z } from "zod"
import { createAgent } from "langchain"
import { activeProviderId, resolveModel, selectionOf, selectionSignature } from "./providers/registry.ts"
import { threadContextFor } from "./thread-context.ts"
import { buildSystemPrompt, type EditToolName } from "./prompt.ts"
import { applyPatch } from "./tools/apply-patch.ts"
import { bash } from "./tools/bash.ts"
import { editTool } from "./tools/edit.ts"
import { read } from "./tools/read.ts"
import { write } from "./tools/write.ts"

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
      "Delegate a focused subtask to an independent child agent thread that streams its own work live and can " +
      "spawn its own children. Returns the child thread's final answer.",
    schema: z.object({
      title: z.string().describe("Short title shown in the UI (e.g. 'List project files')."),
      instructions: z.string().describe("Full task/instructions for the child agent."),
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
    return BunSqliteSaver.fromConnString(process.env.CHUNKY_GRAPH_DB || "chunky-graph.db")
  } catch (err) {
    const { MemorySaver } = require("@langchain/langgraph")
    console.warn(`[@chunky/server] durable checkpointer unavailable (${(err as Error).message}); using in-memory`)
    return new MemorySaver()
  }
}

export interface BuildAgentOpts {
  // Retained for compatibility. Real nested threads now come from the spawn_thread
  // tool (see threads.ts), not DeepAgents' subagent roster / task tool, so this is
  // no longer wired into agent construction.
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
 * Pick the edit tool(s) for the active model. GPT/Codex models are trained on
 * the V4A `apply_patch` format, so they get that tool (name "apply_patch");
 * every other model gets the Pi-ported `edit` tool (name "edit"). Exactly one
 * edit tool is bound per model — this is the per-model swap.
 */
export function editToolsForModel(modelId: string | undefined, providerId: string) {
  return isGptCodexFamily(modelId, providerId) ? [applyPatch] : [editTool]
}

/** The name of the edit tool bound for the active model — used to adapt the
 *  system prompt's edit guidance to whichever tool the model actually has. */
export function editToolNameForModel(modelId: string | undefined, providerId: string): EditToolName {
  return isGptCodexFamily(modelId, providerId) ? "apply_patch" : "edit"
}

/** Build the lean agent for the active provider. Tools read/bash/write/edit
 *  operate directly on WORKSPACE via node:fs; the system prompt is ~300 tokens. */
export function buildAgent(_opts: BuildAgentOpts = {}) {
  const providerId = activeProviderId()
  const modelId = selectionOf(providerId).model
  // TODO: prompt-caching middleware. langchain exports anthropicPromptCachingMiddleware,
  // but every current provider builds an OpenAI-compatible ChatOpenAI (zen/grok/codex),
  // not ChatAnthropic, so it would be a no-op here. Wire it in if/when an Anthropic
  // provider lands.
  return createAgent({
    model: resolveModel(),
    tools: [read, bash, write, spawnThread, ...editToolsForModel(modelId, providerId)],
    systemPrompt: buildSystemPrompt(editToolNameForModel(modelId, providerId)),
    checkpointer: makeCheckpointer(),
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
