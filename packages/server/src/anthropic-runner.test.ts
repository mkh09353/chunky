// Deterministic contract checks for the alternate Anthropic Agent SDK loop.
// No network/model call is made here; anthropic.e2e.manual.ts is the live proof.
import type { AgentEvent } from "@chunky/protocol"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { buildSystemPrompt } from "./prompt.ts"
import {
  buildAnthropicOptions,
  translateAnthropicMessages,
  type AnthropicRunnerDependencies,
} from "./anthropic-runner.ts"
import { anthropicOAuthEnvironment } from "./providers/anthropic-sdk.ts"
import type { AgentSelection } from "./providers/registry.ts"

const selection: AgentSelection = Object.freeze({
  provider: "anthropic",
  model: "sonnet",
  effort: "high",
})

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`)
}

async function* messages(items: unknown[]): AsyncGenerator<SDKMessage> {
  for (const item of items) yield item as SDKMessage
}

const fakeQuery = (() => {
  throw new Error("fake query should not be called while building options")
}) as AnthropicRunnerDependencies["query"]

async function main() {
  const events: AgentEvent[] = []
  const emit = (event: AgentEvent) => events.push(event)

  const fresh = await buildAnthropicOptions(
    { selection, threadId: "11111111-1111-4111-8111-111111111111", emit },
    {
      query: fakeQuery,
      getSessionInfo: (async () => undefined) as AnthropicRunnerDependencies["getSessionInfo"],
    },
  )
  assert(fresh.systemPrompt === buildSystemPrompt("edit"), "SDK must receive Chunky's exact edit prompt")
  assert(Array.isArray(fresh.tools) && fresh.tools.length === 0, "all Claude built-in tools must be disabled")
  assert(Array.isArray(fresh.settingSources) && fresh.settingSources.length === 0, "filesystem settings must be disabled")
  assert(fresh.permissionMode === "dontAsk", "only pre-approved Chunky MCP tools should run")
  assert(fresh.allowedTools?.length === 1 && fresh.allowedTools[0] === "mcp__chunky__*", "only Chunky MCP is allowed")
  assert(fresh.sessionId === "11111111-1111-4111-8111-111111111111", "fresh sessions use Chunky's UUID")
  assert(!fresh.resume, "fresh sessions must not resume")
  assert(fresh.env?.ANTHROPIC_API_KEY === undefined, "API-key auth must be removed")
  assert(fresh.env?.ANTHROPIC_AUTH_TOKEN === undefined, "bearer API auth must be removed")
  assert(fresh.env?.ANTHROPIC_BASE_URL === undefined, "custom API routing must be removed")
  assert(fresh.env?.ANTHROPIC_PROFILE === undefined, "alternate Anthropic auth profiles must be removed")
  assert(fresh.env?.CLAUDE_CODE_USE_GATEWAY === undefined, "enterprise gateway auth must be removed")
  assert(fresh.mcpServers?.chunky?.type === "sdk", "Chunky tools must be an in-process SDK MCP server")

  const resumed = await buildAnthropicOptions(
    {
      selection,
      threadId: "22222222-2222-4222-8222-222222222222",
      emit,
      eventThreadId: "child",
    },
    {
      query: fakeQuery,
      getSessionInfo: (async () => ({
        sessionId: "22222222-2222-4222-8222-222222222222",
        summary: "test session",
        lastModified: Date.now(),
      })) as AnthropicRunnerDependencies["getSessionInfo"],
    },
  )
  assert(resumed.resume === "22222222-2222-4222-8222-222222222222", "existing SDK sessions must resume")
  assert(!resumed.sessionId, "resumed sessions must not start a duplicate session")

  const final = await translateAnthropicMessages(
    messages([
      {
        type: "system",
        subtype: "init",
        apiKeySource: "oauth",
        tools: ["mcp__chunky__read", "mcp__chunky__bash"],
      },
      {
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "hello " } },
      },
      {
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "oauth" } },
      },
      { type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "max_tokens" } } },
      { type: "stream_event", event: { type: "message_stop" } },
      { type: "result", subtype: "success", result: "hello oauth" },
    ]),
    "child-thread",
    emit,
  )
  assert(final === "hello oauth", "streamed text must be returned")
  assert(events.some((event) => event.type === "message.start" && event.threadId === "child-thread"), "child start tagged")
  assert(events.some((event) => event.type === "message.delta" && event.text === "oauth"), "text delta emitted")
  assert(events.some((event) => event.type === "message.end" && event.threadId === "child-thread" && event.reason === "max_tokens"), "child end reason tagged")

  let rejectedApiKey = false
  try {
    await translateAnthropicMessages(
      messages([{ type: "system", subtype: "init", apiKeySource: "user", tools: ["mcp__chunky__read"] }]),
      undefined,
      emit,
    )
  } catch (err) {
    rejectedApiKey = String(err).includes("expected Claude OAuth")
  }
  assert(rejectedApiKey, "non-OAuth SDK initialization must fail closed")

  const env = anthropicOAuthEnvironment()
  assert(env.CLAUDE_AGENT_SDK_CLIENT_APP === "chunky-cli/0.0.0", "SDK client app must be identified")
  console.log("PASS: Anthropic SDK uses OAuth, Chunky's prompt/tools, streaming events, and durable resume")
}

await main()
