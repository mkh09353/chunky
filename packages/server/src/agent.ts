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
import { createAgent, summarizationMiddleware } from "langchain"
import {
  activeSelection,
  resolveModel,
  selectionSignature,
  type AgentSelection,
  type Effort,
  type Speed,
} from "./providers/registry.ts"
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
interface SpawnThreadInput {
  title: string
  instructions: string
  provider?: string
  model?: string
  effort?: Effort
  speed?: Speed
}

const spawnThread = tool(
  async ({ title, instructions, provider, model, effort, speed }: SpawnThreadInput, config?: unknown) => {
    const callerThreadId = (config as any)?.configurable?.thread_id as string | undefined
    const ctx = threadContextFor(callerThreadId)
    if (!ctx || !callerThreadId) {
      return "error: spawn_thread is only available inside an active session run."
    }
    const hasSelectionOverride = provider !== undefined || model !== undefined || effort !== undefined || speed !== undefined
    const text = await ctx.spawn({
      callerThreadId,
      title,
      instructions,
      selection: hasSelectionOverride ? { provider, model, effort, speed } : undefined,
    })
    return `Child thread "${title}" finished.\n\n${text}`
  },
  {
    name: "spawn_thread",
    description:
      "Delegate a focused subtask to an independent child agent thread that streams its own work live and can " +
      "spawn its own children. Omit model-selection fields to inherit this thread's model, or choose a configured " +
      "provider/model when a different model is better suited. Returns the child thread's final answer.",
    schema: z.object({
      title: z.string().describe("Short title shown in the UI (e.g. 'List project files')."),
      instructions: z.string().describe("Full task/instructions for the child agent."),
      provider: z.string().optional().describe("Optional provider id for the child; defaults to this thread's provider."),
      model: z.string().optional().describe("Optional model id for the child; defaults to the inherited/provider selection."),
      effort: z.enum(["low", "medium", "high", "xhigh"]).optional().describe("Optional reasoning effort for the child."),
      speed: z.enum(["standard", "fast"]).optional().describe("Optional speed setting for the child."),
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

/** Build the lean agent for one explicit provider/model selection. Tools
 * read/bash/write/edit operate directly on WORKSPACE via node:fs; the system
 * prompt is ~300 tokens. */
export function buildAgent(selection: AgentSelection = activeSelection(), _opts: BuildAgentOpts = {}) {
  const providerId = selection.provider
  const modelId = selection.model
  const model = resolveModel(selection)
  // TODO: prompt-caching middleware. langchain exports anthropicPromptCachingMiddleware,
  // but every current provider builds an OpenAI-compatible ChatOpenAI (zen/grok/codex),
  // not ChatAnthropic, so it would be a no-op here. Wire it in if/when an Anthropic
  // provider lands.
  return createAgent({
    model,
    tools: [read, bash, write, spawnThread, ...editToolsForModel(modelId, providerId)],
    systemPrompt: buildSystemPrompt(editToolNameForModel(modelId, providerId)),
    checkpointer: makeCheckpointer(),
    // Auto-compaction — the context-management half of Pi's efficiency win (a
    // "tighter working set" so long sessions don't grow unbounded, which is what we
    // lost by dropping createDeepAgent's SummarizationMiddleware). Once history grows
    // past ~100k tokens, older messages are summarized while the most recent 20 are
    // kept verbatim; the active model writes the summary. A token trigger (not a
    // context-window fraction) keeps this provider-agnostic — Zen/Codex ChatOpenAI
    // instances don't reliably report a context size. Move to { fraction } once model
    // profiles carry context windows.
    middleware: [
      summarizationMiddleware({
        model,
        trigger: { tokens: 100_000 },
        keep: { messages: 20 },
      }),
    ],
  })
}

// Cache one agent per full SELECTION signature (provider + model + effort +
// speed) so switching provider, model, OR a reasoning knob rebuilds the model,
// while an unchanged selection reuses its agent (keeping live thread state). The
// durable sqlite checkpointer is keyed by thread_id, so even a rebuilt agent
// resumes prior memory from disk.
// Agents are intentionally lazy: deterministic thread tests can inject a fake
// stream without requiring any provider credentials at module-import time.
const agentCache = new Map<string, ReturnType<typeof buildAgent>>()

/** The agent for one explicit selection, rebuilt on first use per signature. */
export function getAgent(selection: AgentSelection = activeSelection()): ReturnType<typeof buildAgent> {
  const sig = selectionSignature(selection)
  let a = agentCache.get(sig)
  if (!a) {
    a = buildAgent(selection)
    agentCache.set(sig, a)
  }
  return a
}

/** Drop cached agents so the next getAgent() rebuilds for the current selection.
 *  The /api/model/select route calls this after persisting a new selection. */
export function invalidateAgent(): void {
  agentCache.clear()
}
