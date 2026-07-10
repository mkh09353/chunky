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
import { randomUUID } from "node:crypto"
import { z } from "zod"
import { taggedEmitter, type Emit } from "./event-emitter.ts"
import { buildSystemPrompt } from "./prompt.ts"
import type { AgentSelection } from "./providers/registry.ts"
import { anthropicOAuthEnvironment } from "./providers/anthropic-sdk.ts"
import { WORKSPACE } from "./workspace.ts"
import { bash, bashInputShape } from "./tools/bash.ts"
import { editInputShape, editTool } from "./tools/edit.ts"
import { read, readInputShape } from "./tools/read.ts"
import { spawnThread, spawnThreadInputShape } from "./tools/spawn-thread.ts"
import { write, writeInputShape } from "./tools/write.ts"

const SERVER_NAME = "chunky"
const ALLOWED_TOOLS = [`mcp__${SERVER_NAME}__*`]
const CHUNKY_TOOLS = [read, bash, write, editTool, spawnThread]
const SDK_TOOL_NAMES = new Set(CHUNKY_TOOLS.map((chunkyTool) => `mcp__${SERVER_NAME}__${chunkyTool.name}`))
const knownSessions = new Set<string>()

type QueryFactory = typeof query
type SessionInfoReader = typeof getSessionInfo

export interface AnthropicRunnerDependencies {
  query: QueryFactory
  getSessionInfo: SessionInfoReader
}

const defaultDependencies: AnthropicRunnerDependencies = { query, getSessionInfo }

function outputText(value: unknown): string {
  if (typeof value === "string") return value
  if (value == null) return ""
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
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
    async (args) => {
      const id = randomUUID()
      emit({ type: "tool.start", id, name, input: args })
      try {
        const output = outputText(await invoke(args as z.infer<z.ZodObject<Shape>>))
        emit({ type: "tool.end", id, ok: true, output })
        return { content: [{ type: "text" as const, text: output }] }
      } catch (err) {
        const output = (err as Error)?.message ?? String(err)
        emit({ type: "tool.end", id, ok: false, output })
        return { content: [{ type: "text" as const, text: output }], isError: true }
      }
    },
    annotations ? { annotations } : undefined,
  )
}

export function createChunkySdkMcpServer(callerThreadId: string, emitRoot: Emit, displayThreadId?: string) {
  const emit = taggedEmitter(emitRoot, displayThreadId)
  const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  return createSdkMcpServer({
    name: SERVER_NAME,
    version: "0.0.0",
    alwaysLoad: true,
    tools: [
      wrapChunkyTool(
        read.name,
        read.description,
        readInputShape,
        (args) => read.invoke(args),
        emit,
        readOnly,
      ),
      wrapChunkyTool(
        bash.name,
        bash.description,
        bashInputShape,
        (args) => bash.invoke(args),
        emit,
      ),
      wrapChunkyTool(
        write.name,
        write.description,
        writeInputShape,
        (args) => write.invoke(args),
        emit,
      ),
      wrapChunkyTool(
        editTool.name,
        editTool.description,
        editInputShape,
        (args) => editTool.invoke(args),
        emit,
      ),
      wrapChunkyTool(
        spawnThread.name,
        spawnThread.description,
        spawnThreadInputShape,
        (args) => spawnThread.invoke(args, { configurable: { thread_id: callerThreadId } }),
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
}

export async function buildAnthropicOptions(
  request: Omit<AnthropicRunRequest, "prompt">,
  dependencies: AnthropicRunnerDependencies = defaultDependencies,
): Promise<AnthropicOptions> {
  const { selection, threadId, emit, eventThreadId, freshSession } = request
  const shouldResume =
    !freshSession &&
    (knownSessions.has(threadId) || Boolean(await dependencies.getSessionInfo(threadId, { dir: WORKSPACE }).catch(() => undefined)))
  return {
    cwd: WORKSPACE,
    env: anthropicOAuthEnvironment(),
    model: selection.model || undefined,
    effort: selection.effort,
    systemPrompt: buildSystemPrompt("edit"),
    tools: [],
    settingSources: [],
    mcpServers: { [SERVER_NAME]: createChunkySdkMcpServer(threadId, emit, eventThreadId) },
    allowedTools: ALLOWED_TOOLS,
    permissionMode: "dontAsk",
    includePartialMessages: true,
    persistSession: true,
    ...(shouldResume ? { resume: threadId } : { sessionId: threadId }),
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
): Promise<string> {
  const emit = taggedEmitter(emitRoot, displayThreadId)
  let assistantOpen = false
  const textChunks: string[] = []
  let sawInit = false

  const openAssistant = () => {
    if (!assistantOpen) {
      assistantOpen = true
      emit({ type: "message.start", role: "assistant" })
    }
  }
  const closeAssistant = () => {
    if (assistantOpen) {
      assistantOpen = false
      emit({ type: "message.end" })
    }
  }
  const appendText = (text: string) => {
    if (!text) return
    openAssistant()
    textChunks.push(text)
    emit({ type: "message.delta", text })
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
          appendText(event.delta.text ?? "")
        } else if (event?.type === "message_stop") {
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
      }
    }
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
    const finalText = await translateAnthropicMessages(q, request.eventThreadId, request.emit)
    knownSessions.add(request.threadId)
    return finalText
  } finally {
    q.close()
  }
}
