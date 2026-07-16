// Alternate agent loop for the Anthropic Agent SDK. Claude Code's built-ins and
// filesystem settings are disabled; the only callable tools are in-process MCP
// wrappers around Chunky's own LangChain tools.
import {
  createSdkMcpServer,
  getSessionInfo,
  query,
  tool as sdkTool,
  type Options as AnthropicOptions,
  type Query,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk"
import { createHash, randomUUID } from "node:crypto"
import { z } from "zod"
import type { MessageEndReason } from "@chunky/protocol"
import { taggedEmitter, type Emit } from "./event-emitter.ts"
import { buildSystemPrompt } from "./prompt.ts"
import { listSidekickSeats, sidekickFor, type AgentSelection } from "./providers/registry.ts"
import { anthropicOAuthEnvironment } from "./providers/anthropic-sdk.ts"
import { usageFromAnthropicResult } from "./usage.ts"
import { noteRequest } from "./cache-watch.ts"
import type { CacheContext } from "./run.ts"
import { LAUNCH_WORKSPACE } from "./workspace.ts"
import { bash, bashInputShape } from "./tools/bash.ts"
import { editInputShape, editTool } from "./tools/edit.ts"
import { fffind, fffindInputShape, ffgrep, ffgrepInputShape } from "./tools/fff.ts"
import {
  createGoalInputShape,
  createGoalTool,
  getGoalInputShape,
  getGoalTool,
  goalBlockedInputShape,
  goalBlockedTool,
  goalCompleteInputShape,
  goalCompleteTool,
} from "./tools/goal.ts"
import { read, readInputShape } from "./tools/read.ts"
import { shipGoal, shipGoalInputShape } from "./tools/ship.ts"
import { sidekick, sidekickInputShape } from "./tools/sidekick.ts"
import { spawnThread, spawnThreadInputShape } from "./tools/spawn-thread.ts"
import { workflow, workflowInputShape } from "./tools/workflow.ts"
import { manageModels, manageModelsInputShape } from "./tools/manage-models.ts"
import {
  manageSkillReposTool,
  manageSkillReposInputShape,
} from "./tools/manage-skill-repos.ts"
import {
  loadSkillInputShape,
  loadSkillTool,
  searchSkillsInputShape,
  searchSkillsTool,
} from "./tools/skills.ts"
import { write, writeInputShape } from "./tools/write.ts"
import { asToolRunResult } from "./tools/result.ts"
import { getTaskOutput, killTask } from "./tools/task.ts"
import { hashlineEdit, hashlineRead } from "./tools/hashline/index.ts"
import { resolveFileToolProfile, type FileToolProfile } from "./settings.ts"

const SERVER_NAME = "chunky"
const ALLOWED_TOOLS = [`mcp__${SERVER_NAME}__*`]
const CHUNKY_TOOLS = [
  read,
  bash,
  getTaskOutput,
  killTask,
  fffind,
  ffgrep,
  write,
  editTool,
  sidekick,
  spawnThread,
  workflow,
  manageModels,
  manageSkillReposTool,
  searchSkillsTool,
  loadSkillTool,
  getGoalTool,
  createGoalTool,
  goalCompleteTool,
  goalBlockedTool,
  shipGoal,
]
const SDK_TOOL_NAMES = new Set(CHUNKY_TOOLS.map((chunkyTool) => `mcp__${SERVER_NAME}__${chunkyTool.name}`))
const knownSessions = new Set<string>()

/** File tools used by the SDK MCP server. Names intentionally remain read/edit. */
export function anthropicFileTools(profile: FileToolProfile = resolveFileToolProfile()) {
  return profile === "hashline" ? { read: hashlineRead, edit: hashlineEdit } : { read, edit: editTool }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Claude Code requires the SDK `sessionId`/`resume` to be a valid UUID. Root
 * sessions and spawned children already are one (randomUUID), but the always-on
 * advisor runs on a STABLE non-UUID id (`${rootId}:advisor`) for resume
 * continuity, which the subprocess rejects with "Invalid session ID. Must be a
 * valid UUID." (exit 1). Pass UUID thread ids through unchanged; derive a
 * deterministic v5-shaped UUID for any that aren't, so the advisor keeps a stable
 * session identity that resumes across consults and restarts. */
function sdkSessionId(threadId: string): string {
  if (UUID_RE.test(threadId)) return threadId
  const h = createHash("sha256").update(threadId).digest("hex")
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`
}

type QueryFactory = typeof query
type SessionInfoReader = typeof getSessionInfo

export interface AnthropicRunnerDependencies {
  query: QueryFactory
  getSessionInfo: SessionInfoReader
}

const defaultDependencies: AnthropicRunnerDependencies = { query, getSessionInfo }

export async function runChunkyToolForSdk(
  name: string,
  args: unknown,
  invoke: (args: any) => Promise<unknown>,
  emit: ReturnType<typeof taggedEmitter>,
) {
  const id = randomUUID()
  emit({ type: "tool.start", id, name, input: args })
  try {
    const result = asToolRunResult(await invoke(args))
    emit({
      type: "tool.end",
      id,
      ok: result.ok,
      output: result.promptText,
      ...(result.raw !== undefined ? { raw: result.raw } : {}),
    })
    return { content: [{ type: "text" as const, text: result.promptText }] }
  } catch (err) {
    const output = (err as Error)?.message ?? String(err)
    emit({ type: "tool.end", id, ok: false, output })
    return { content: [{ type: "text" as const, text: output }], isError: true }
  }
}

/** Build an SDK tool handler around a Chunky LangChain tool. Calling invoke()
 * reuses the exact implementation already used by Zen, Grok, and Codex. */
function wrapChunkyTool<Shape extends Record<string, z.ZodTypeAny>>(
  name: string,
  description: string,
  inputShape: Shape,
  invoke: (args: z.infer<z.ZodObject<Shape>>) => Promise<unknown>,
  emit: ReturnType<typeof taggedEmitter>,
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean },
) {
  return sdkTool(
    name,
    description,
    inputShape,
    (args) => runChunkyToolForSdk(name, args, invoke, emit),
    annotations ? { annotations } : undefined,
  )
}

export function createChunkySdkMcpServer(
  callerThreadId: string,
  emitRoot: Emit,
  displayThreadId?: string,
  workspace: string = LAUNCH_WORKSPACE,
) {
  const emit = taggedEmitter(emitRoot, displayThreadId)
  const fileTools = anthropicFileTools()
  const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  // The same RunnableConfig the LangChain runtime would pass: thread identity for
  // session-scoped tools (spawn/goal) plus the run's workspace for fs/search tools.
  const runConfig = { configurable: { thread_id: callerThreadId, workspace } }
  return createSdkMcpServer({
    name: SERVER_NAME,
    version: "0.0.0",
    alwaysLoad: true,
    tools: [
      wrapChunkyTool(
        fileTools.read.name,
        fileTools.read.description,
        readInputShape,
        (args) => fileTools.read.invoke(args, runConfig),
        emit,
        readOnly,
      ),
      wrapChunkyTool(
        bash.name,
        bash.description,
        bashInputShape,
        (args) => bash.invoke(args, runConfig),
        emit,
      ),
      wrapChunkyTool(
        fffind.name,
        fffind.description,
        fffindInputShape,
        (args) => fffind.invoke(args, runConfig),
        emit,
        readOnly,
      ),
      wrapChunkyTool(
        ffgrep.name,
        ffgrep.description,
        ffgrepInputShape,
        (args) => ffgrep.invoke(args, runConfig),
        emit,
        readOnly,
      ),
      wrapChunkyTool(
        write.name,
        write.description,
        writeInputShape,
        (args) => write.invoke(args, runConfig),
        emit,
      ),
      wrapChunkyTool(
        fileTools.edit.name,
        fileTools.edit.description,
        editInputShape,
        (args) => fileTools.edit.invoke(args, runConfig),
        emit,
      ),
      // sidekick resolves its ThreadManager from the caller thread exactly like
      // spawn_thread — the default delegation path for Anthropic-runtime leads
      // (Claude/Fable), whose handoffs run the persistent worker side thread.
      wrapChunkyTool(
        sidekick.name,
        sidekick.description,
        sidekickInputShape,
        (args) => sidekick.invoke(args, runConfig),
        emit,
      ),
      wrapChunkyTool(
        spawnThread.name,
        spawnThread.description,
        spawnThreadInputShape,
        (args) => spawnThread.invoke(args, runConfig),
        emit,
      ),
      // workflow resolves its ThreadManager from the caller thread exactly like
      // spawn_thread — required for workflows-mode goals when the orchestrator
      // runs on the Anthropic SDK runtime (Claude/Fable).
      wrapChunkyTool(
        workflow.name,
        workflow.description,
        workflowInputShape,
        (args) => workflow.invoke(args, runConfig),
        emit,
      ),
      wrapChunkyTool(
        manageModels.name,
        manageModels.description,
        manageModelsInputShape,
        (args) => manageModels.invoke(args, runConfig),
        emit,
      ),
      wrapChunkyTool(
        manageSkillReposTool.name,
        manageSkillReposTool.description,
        manageSkillReposInputShape,
        (args) => manageSkillReposTool.invoke(args, runConfig),
        emit,
      ),
      // Lazy Agent Skills — metadata via search, full body only on explicit load.
      wrapChunkyTool(
        searchSkillsTool.name,
        searchSkillsTool.description,
        searchSkillsInputShape,
        (args) => searchSkillsTool.invoke(args, runConfig),
        emit,
        readOnly,
      ),
      wrapChunkyTool(
        loadSkillTool.name,
        loadSkillTool.description,
        loadSkillInputShape,
        (args) => loadSkillTool.invoke(args, runConfig),
        emit,
        { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      ),
      // Goal-mode tools resolve the session from the caller thread the same way
      // spawn_thread does, so goal_complete/goal_blocked reach the right goal.
      wrapChunkyTool(
        getGoalTool.name,
        getGoalTool.description,
        getGoalInputShape,
        (args) => getGoalTool.invoke(args, runConfig),
        emit,
        readOnly,
      ),
      wrapChunkyTool(
        createGoalTool.name,
        createGoalTool.description,
        createGoalInputShape,
        (args) => createGoalTool.invoke(args, runConfig),
        emit,
      ),
      wrapChunkyTool(
        goalCompleteTool.name,
        goalCompleteTool.description,
        goalCompleteInputShape,
        (args) => goalCompleteTool.invoke(args, runConfig),
        emit,
      ),
      wrapChunkyTool(
        goalBlockedTool.name,
        goalBlockedTool.description,
        goalBlockedInputShape,
        (args) => goalBlockedTool.invoke(args, runConfig),
        emit,
      ),
      wrapChunkyTool(
        shipGoal.name,
        shipGoal.description,
        shipGoalInputShape,
        (args) => shipGoal.invoke(args, runConfig),
        emit,
      ),
    ],
  })
}

export interface AnthropicRunRequest {
  selection: AgentSelection
  threadId: string
  prompt: string
  emit: Emit
  eventThreadId?: string
  freshSession?: boolean
  /** Override the system prompt (e.g. the read-only advisor prompt). */
  systemPrompt?: string
  /** Override which MCP tools are callable (e.g. read-only for the advisor). */
  allowedTools?: string[]
  /** When set, feed the SDK result's token counts to the prompt-cache watch. */
  cache?: CacheContext
  /** Abort the in-flight SDK query (user interrupt). */
  abort?: AbortController
  /** The session's workspace (cwd + tool jail). Defaults to the launch dir. */
  workspace?: string
  agentsMd?: string | null
}

export async function buildAnthropicOptions(
  request: Omit<AnthropicRunRequest, "prompt">,
  dependencies: AnthropicRunnerDependencies = defaultDependencies,
): Promise<AnthropicOptions> {
  const { selection, threadId, emit, eventThreadId, freshSession } = request
  const workspace = request.workspace ?? LAUNCH_WORKSPACE
  const sessionId = sdkSessionId(threadId)
  const shouldResume =
    !freshSession &&
    (knownSessions.has(threadId) || Boolean(await dependencies.getSessionInfo(sessionId, { dir: workspace }).catch(() => undefined)))
  return {
    cwd: workspace,
    env: anthropicOAuthEnvironment(),
    ...(request.abort ? { abortController: request.abort } : {}),
    model: selection.model || undefined,
    effort: selection.effort,
    systemPrompt:
      request.systemPrompt ??
      buildSystemPrompt("edit", false, workspace, {
        hasSidekick: sidekickFor(selection) != null,
        sidekickSeats: listSidekickSeats(),
        agentsMd: request.agentsMd,
      }),
    tools: [],
    settingSources: [],
    mcpServers: { [SERVER_NAME]: createChunkySdkMcpServer(threadId, emit, eventThreadId, workspace) },
    allowedTools: request.allowedTools ?? ALLOWED_TOOLS,
    permissionMode: "dontAsk",
    includePartialMessages: true,
    persistSession: true,
    ...(shouldResume ? { resume: sessionId } : { sessionId }),
  }
}

function assertOAuthOnlyInit(message: Extract<SDKMessage, { type: "system"; subtype: "init" }>): void {
  // Current subscription-backed SDK builds report "none" here because the
  // credential is loaded from Claude's local OAuth session rather than an API
  // key source. Explicit API-key sources remain a hard failure.
  const credentialSource = message.apiKeySource as string
  if (credentialSource !== "oauth" && credentialSource !== "none") {
    throw new Error(`anthropic: expected Claude OAuth, SDK reported credential source "${credentialSource}"`)
  }
  const unexpectedTools = message.tools.filter((name) => !SDK_TOOL_NAMES.has(name))
  if (unexpectedTools.length > 0) {
    throw new Error(`anthropic: SDK exposed tools outside Chunky's MCP server: ${unexpectedTools.join(", ")}`)
  }
}

export async function translateAnthropicMessages(
  messages: AsyncIterable<SDKMessage>,
  displayThreadId: string | undefined,
  emitRoot: Emit,
  cache?: CacheContext,
): Promise<string> {
  const emit = taggedEmitter(emitRoot, displayThreadId)
  let assistantOpen = false
  const textChunks: string[] = []
  let sawInit = false
  let pendingEndReason: MessageEndReason = "complete"

  const openAssistant = () => {
    if (!assistantOpen) {
      assistantOpen = true
      emit({ type: "message.start", role: "assistant" })
    }
  }
  const closeAssistant = (reason: MessageEndReason = pendingEndReason) => {
    if (assistantOpen) {
      assistantOpen = false
      emit({ type: "message.end", reason })
      pendingEndReason = "complete"
    }
  }
  const appendText = (text: string) => {
    if (!text) return
    openAssistant()
    textChunks.push(text)
    emit({ type: "message.delta", text })
  }

  // Extended-thinking blocks arrive as `thinking_delta` content deltas BEFORE the
  // answer text. Stream them as reasoning.* so the TUI shows a collapsible thought.
  let reasoningOpen = false
  const openReasoning = () => {
    if (!reasoningOpen) {
      reasoningOpen = true
      emit({ type: "reasoning.start" })
    }
  }
  const closeReasoning = () => {
    if (reasoningOpen) {
      reasoningOpen = false
      emit({ type: "reasoning.end" })
    }
  }
  const appendReasoning = (text: string) => {
    if (!text) return
    openReasoning()
    emit({ type: "reasoning.delta", text })
  }

  try {
    for await (const message of messages) {
      if (message.type === "system" && message.subtype === "init") {
        assertOAuthOnlyInit(message)
        sawInit = true
        continue
      }

      if (message.type === "stream_event") {
        const event = message.event as any
        if (event?.type === "content_block_delta" && event?.delta?.type === "text_delta") {
          closeReasoning() // answer text has begun — the thinking block is done
          appendText(event.delta.text ?? "")
        } else if (event?.type === "content_block_delta" && event?.delta?.type === "thinking_delta") {
          appendReasoning(event.delta.thinking ?? "")
        } else if (event?.type === "message_delta") {
          const stopReason = event?.delta?.stop_reason
          pendingEndReason = stopReason === "max_tokens" ? "max_tokens" : "complete"
        } else if (event?.type === "message_stop") {
          closeReasoning()
          closeAssistant()
        }
        continue
      }

      if (message.type === "assistant" && message.error) {
        closeAssistant()
        emit({ type: "error", message: `Anthropic request failed: ${message.error}` })
        continue
      }

      if (message.type === "result") {
        closeAssistant()
        if (message.subtype === "success") {
          if (textChunks.length === 0 && message.result) appendText(message.result)
        } else {
          const detail = message.errors.join("; ") || message.subtype
          emit({ type: "error", message: `Anthropic Agent SDK failed: ${detail}` })
        }
        // Result carries the turn's usage; arm the cache watch with its prompt
        // size so the next turn can detect a cold cache. Works on subscription
        // OAuth too (token counts are reported even when cost is 0).
        // Record the SELECTION id (cache.model), never delta.model: the SDK's
        // modelUsage includes its auxiliary Haiku calls (title generation etc.),
        // and checkCacheCold compares against the next turn's selection id — a
        // haiku or API-format id here manufactures a false "model switch".
        const delta = usageFromAnthropicResult(message as any)
        if (cache) {
          noteRequest(cache.conversationId, delta, cache.model, Date.now())
        }
        emit({ type: "usage.update", usage: delta })
      }
    }
  } catch (error) {
    closeAssistant((error as Error)?.name === "AbortError" ? "interrupted" : "error")
    throw error
  } finally {
    closeAssistant()
  }

  if (!sawInit) throw new Error("anthropic: Agent SDK stream ended before initialization")
  return textChunks.join("")
}

export async function runAnthropicAgent(
  request: AnthropicRunRequest,
  dependencies: AnthropicRunnerDependencies = defaultDependencies,
): Promise<string> {
  const options = await buildAnthropicOptions(request, dependencies)
  const q: Query = dependencies.query({ prompt: request.prompt, options })
  try {
    const account = await q.accountInfo()
    if (!account.subscriptionType || account.apiProvider !== "firstParty") {
      throw new Error("anthropic: Agent SDK account is not backed by first-party Claude subscription OAuth")
    }
    const finalText = await translateAnthropicMessages(
      q,
      request.eventThreadId,
      request.emit,
      request.cache,
    )
    knownSessions.add(request.threadId)
    return finalText
  } finally {
    q.close()
  }
}
