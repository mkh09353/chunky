// Agent wiring. The model comes from the provider registry (resolveModel), and
// agent construction is a factory (buildAgent) so the threads work can rebuild
// it per provider. Durable state via a SQLite checkpointer.
//
// LEAN HARNESS: we call `createAgent` from `langchain` directly — the same
// primitive `createDeepAgent` wraps — instead of `createDeepAgent`. This sheds
// DeepAgents' heavy defaults (BASE_AGENT_PROMPT, write_todos, the 6 verbose
// filesystem tools, the `task` tool) and replaces them with a compact system
// prompt and core tool set that operate directly
// on the run's workspace (resolved per-call from `configurable.workspace`) via
// node:fs. Checkpointer, streaming, threads, and providers are all unchanged —
// only the agent-construction call differs.
import { tool } from "@langchain/core/tools"
import { z } from "zod"
import { createAgent, summarizationMiddleware } from "langchain"
import {
  activeSelection,
  advisorFor,
  listSidekickSeats,
  resolveModel,
  selectionSignature,
  sidekickFor,
  type AgentSelection,
} from "./providers/registry.ts"
import { threadContextFor } from "./thread-context.ts"
import { LAUNCH_WORKSPACE } from "./workspace.ts"
import { ADVISOR_SYSTEM_PROMPT, sidekickSystemPrompt, buildSystemPrompt, type EditToolName } from "./prompt.ts"
import {
  buildToolSearchMiddleware,
  portableToolSetFor,
  supportsNativeToolSearch,
  toolSearchMiddlewareConfigFor,
} from "./tool-search.ts"
import { applyPatch } from "./tools/apply-patch.ts"
import { bash } from "./tools/bash.ts"
import { editTool } from "./tools/edit.ts"
import { fffind, ffgrep } from "./tools/fff.ts"
import { goalTools } from "./tools/goal.ts"
import { read } from "./tools/read.ts"
import { sessionTools } from "./tools/sessions.ts"
import { shipGoal } from "./tools/ship.ts"
import { sidekick } from "./tools/sidekick.ts"
import { spawnThread } from "./tools/spawn-thread.ts"
import { workflow } from "./tools/workflow.ts"
import { manageModels } from "./tools/manage-models.ts"
import { manageSkillReposTool } from "./tools/manage-skill-repos.ts"
import { skillTools } from "./tools/skills.ts"
import { write } from "./tools/write.ts"

// Re-export pure gating/classification helpers for tests and callers.
export {
  CORE_TOOL_NAMES,
  buildToolSearchMiddleware,
  deferredToolNames,
  isCoreToolName,
  isGptVersionAtLeast,
  parseGptVersion,
  partitionTools,
  portableToolSetFor,
  supportsNativeToolSearch,
  toolSearchMiddlewareConfigFor,
} from "./tool-search.ts"

/**
 * advisor — consult a stronger model on demand. Unlike spawn_thread (a fresh,
 * run-to-completion worker), the advisor is a PERSISTENT side thread on a stable
 * thread_id: it remembers earlier consults this session and gathers its own
 * context via read-only tools. Mirrors spawn_thread's shape — it finds the active
 * run's ThreadManager via configurable.thread_id and delegates to consultAdvisor.
 */
const advisor = tool(
  async ({ question, pointers }: { question: string; pointers?: string }, config?: unknown) => {
    const callerThreadId = (config as any)?.configurable?.thread_id as string | undefined
    const ctx = threadContextFor(callerThreadId)
    if (!ctx || !callerThreadId) {
      return "error: advisor is only available inside an active session run."
    }
    return ctx.consultAdvisor({ callerThreadId, question, pointers })
  },
  {
    name: "advisor",
    description:
      "Consult your advisor — a stronger model running as a persistent side thread that remembers your earlier " +
      "consultations this session and can read files and search the codebase itself. Use it for a hard decision, a " +
      "subtle bug, an architecture/design question, a plan, or when you're stuck. Give it a focused brief: state the " +
      "question and point it at the specific files/lines it needs (e.g. 'review the retry logic in src/net.ts around " +
      "line 80 — it deadlocks under load'). Don't paste whole files — point, don't dump. Ask early rather than " +
      "thrashing. Returns the advisor's guidance.",
    schema: z.object({
      question: z.string().describe("The question or problem to get advice on."),
      pointers: z
        .string()
        .optional()
        .describe(
          "Where to look: files/lines/context the advisor should read (it has read access), plus any brief " +
            "recent-context summary. Point, don't paste whole files.",
        ),
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

/**
 * The executor's toolset for a selection: the always-on read/bash/write +
 * the per-model edit tool + the `sidekick` (the default delegation path, unless
 * disabled), PLUS the `advisor` tool when an advisor is configured AND differs
 * from the executor (always-on + auto-suppress; see advisorFor).
 * Factored out so a test can assert seat presence without building a model.
 */
export function executorToolsFor(selection: AgentSelection) {
  const advisorSel = advisorFor(selection)
  const sidekickSel = sidekickFor(selection)
  const tools = [
    read,
    bash,
    fffind,
    ffgrep,
    write,
    ...(sidekickSel ? [sidekick] : []),
    spawnThread,
    ...goalTools,
    shipGoal,
    ...sessionTools,
    workflow,
    manageModels,
    manageSkillReposTool,
    ...skillTools,
    ...editToolsForModel(selection.model, selection.provider),
    ...(advisorSel ? [advisor] : []),
  ]
  return { tools, hasAdvisor: advisorSel != null, hasSidekick: sidekickSel != null }
}

/** Max LangGraph steps per turn (a step ≈ one model call or tool node). LangGraph
 *  defaults to 25, which is nowhere near enough for real coding — a build/edit turn
 *  is easily dozens-to-hundreds of tool calls. Set high so it's not a wall; it's a
 *  runaway-loop backstop, not a work budget. Applied to every `.stream()` call
 *  (run.ts, threads.ts). Override with CHUNKY_RECURSION_LIMIT. */
export const RECURSION_LIMIT = Number(process.env.CHUNKY_RECURSION_LIMIT) || 500

/**
 * Agent construction plan for a selection: tools, prompt flags, and optional
 * native tool-search middleware config. Pure enough for unit tests — does not
 * call resolveModel / createAgent.
 */
export function agentPlanFor(selection: AgentSelection) {
  const { tools, hasAdvisor, hasSidekick } = executorToolsFor(selection)
  const sidekickSeats = listSidekickSeats()
  const nativeToolSearch = supportsNativeToolSearch(selection.provider, selection.model)
  const toolSearchConfig = toolSearchMiddlewareConfigFor(
    selection.provider,
    selection.model,
    tools,
  )
  return {
    tools,
    hasAdvisor,
    hasSidekick,
    sidekickSeats,
    nativeToolSearch,
    /** Non-null only when gate is open and there is at least one deferred tool. */
    toolSearchConfig,
    editToolName: editToolNameForModel(selection.model, selection.provider),
  }
}

/** Build the lean agent for one explicit provider/model selection + workspace.
 * Tools resolve the run's workspace from `configurable.workspace` at execute
 * time; the workspace here only feeds the system prompt (working directory).
 * The system prompt is ~300 tokens. */
export function buildAgent(
  selection: AgentSelection = activeSelection(),
  workspace: string = LAUNCH_WORKSPACE,
  _opts: BuildAgentOpts = {},
  agentsMd?: string | null,
) {
  const providerId = selection.provider
  const modelId = selection.model
  const model = resolveModel(selection)
  const plan = agentPlanFor(selection)
  // TODO: prompt-caching middleware. langchain exports anthropicPromptCachingMiddleware,
  // but every current provider builds an OpenAI-compatible ChatOpenAI (zen/grok/codex),
  // not ChatAnthropic, so it would be a no-op here. Wire it in if/when an Anthropic
  // provider lands.
  //
  // Native tool search (Codex + GPT ≥ 5.4): providerToolSearchMiddleware defers
  // non-core tools behind OpenAI Responses tool_search. Unsupported provider/model
  // keeps the full always-bound catalog (safe fallback; no middleware, no defer).
  const toolSearchMw = buildToolSearchMiddleware(providerId, modelId, plan.tools)
  const boundTools = portableToolSetFor(providerId, plan.tools)
  return createAgent({
    model,
    tools: boundTools,
    systemPrompt: buildSystemPrompt(plan.editToolName, plan.hasAdvisor, workspace, {
      nativeToolSearch: plan.nativeToolSearch,
      portableToolSearch: providerId === "grok",
      hasSidekick: plan.hasSidekick,
      sidekickSeats: plan.sidekickSeats,
      agentsMd,
    }),
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
        trigger: { tokens: 60_000 },
        keep: { messages: 15 },
      }),
      ...(toolSearchMw ? [toolSearchMw] : []),
    ],
  })
}

// Cache one agent per full SELECTION signature (provider + model + effort +
// speed) AND workspace — the workspace is baked into the system prompt, so each
// repo gets its own agent instance (OpenCode's per-directory instance pattern)
// and sessions in different repos run concurrently without sharing a cwd. The
// durable sqlite checkpointer is keyed by thread_id, so even a rebuilt agent
// resumes prior memory from disk.
// Agents are intentionally lazy: deterministic thread tests can inject a fake
// stream without requiring any provider credentials at module-import time.
const agentCache = new Map<string, ReturnType<typeof buildAgent>>()

/** The agent for one selection + workspace, rebuilt on first use per key. */
export function getAgent(
  selection: AgentSelection = activeSelection(),
  workspace: string = LAUNCH_WORKSPACE,
  agentsMd?: string | null,
): ReturnType<typeof buildAgent> {
  const sig = `${selectionSignature(selection)}@@${workspace}@@${agentsMd ?? ""}`
  let a = agentCache.get(sig)
  if (!a) {
    a = buildAgent(selection, workspace, {}, agentsMd)
    agentCache.set(sig, a)
  }
  return a
}

/** Drop cached agents so the next getAgent() rebuilds for the current selection.
 *  The /api/model/select and /api/advisor routes call this after a config change —
 *  the latter so executors rebuild to add/drop the always-on advisor tool. */
export function invalidateAgent(): void {
  agentCache.clear()
}

/**
 * Build the READ-ONLY advisor agent for one selection. It gets ONLY read + bash
 * (it advises, it must not mutate code — no edit/write/apply_patch/spawn_thread/
 * advisor) and its own system prompt. ThreadManager.consultAdvisor drives it as a
 * persistent side thread on a stable thread_id, so the checkpointer gives it
 * continuity across consults.
 */
export function buildAdvisorAgent(selection: AgentSelection) {
  const model = resolveModel(selection)
  return createAgent({
    model,
    tools: [read, bash, fffind, ffgrep],
    systemPrompt: ADVISOR_SYSTEM_PROMPT,
    checkpointer: makeCheckpointer(),
    middleware: [
      summarizationMiddleware({
        model,
        trigger: { tokens: 60_000 },
        keep: { messages: 15 },
      }),
    ],
  })
}

/** The advisor agent for one selection, cached in the SAME agentCache (keyed
 *  "advisor::<sig>") so invalidateAgent() clears it too. Its prompt embeds no
 *  working directory (tools resolve the run's workspace per-call), so one
 *  instance per selection serves every repo. ThreadManager's default
 *  advisorAgentFor injectable. */
export function getAdvisorAgent(selection: AgentSelection = activeSelection()): ReturnType<typeof buildAgent> {
  const sig = "advisor::" + selectionSignature(selection)
  let a = agentCache.get(sig)
  if (!a) {
    a = buildAdvisorAgent(selection) as ReturnType<typeof buildAgent>
    agentCache.set(sig, a)
  }
  return a
}

/**
 * Build the WORKER sidekick agent for one selection. It gets the full hands-on
 * toolset — read/bash/fffind/ffgrep/write + the per-model edit tool — but NO
 * delegation tools (no spawn_thread/workflow/advisor/sidekick: it executes
 * briefs, it doesn't manage). ThreadManager.delegateToSidekick drives it as a
 * persistent side thread on a stable thread_id, so the checkpointer gives it
 * continuity across handoffs — that's what makes follow-up briefs cheap.
 */
export function buildSidekickAgent(selection: AgentSelection, agentsMd?: string | null) {
  const model = resolveModel(selection)
  return createAgent({
    model,
    tools: [read, bash, fffind, ffgrep, write, ...editToolsForModel(selection.model, selection.provider)],
    systemPrompt: sidekickSystemPrompt(agentsMd),
    checkpointer: makeCheckpointer(),
    middleware: [
      summarizationMiddleware({
        model,
        trigger: { tokens: 60_000 },
        keep: { messages: 15 },
      }),
    ],
  })
}

/** The sidekick agent for one selection, cached in the SAME agentCache (keyed
 *  "sidekick::<sig>") so invalidateAgent() clears it too. ThreadManager's default
 *  sidekickAgentFor injectable. */
export function getSidekickAgent(selection: AgentSelection = activeSelection(), _workspace?: string, agentsMd?: string | null): ReturnType<typeof buildAgent> {
  const sig = "sidekick::" + selectionSignature(selection) + "@@" + (agentsMd ?? "")
  let a = agentCache.get(sig)
  if (!a) {
    a = buildSidekickAgent(selection, agentsMd) as ReturnType<typeof buildAgent>
    agentCache.set(sig, a)
  }
  return a
}
