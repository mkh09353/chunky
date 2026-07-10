// Live Anthropic Agent SDK proof. Requires Claude subscription OAuth via either
// `claude auth login --claudeai` or CLAUDE_CODE_OAUTH_TOKEN.
//
// Run: bun run packages/server/src/anthropic.e2e.manual.ts
import { randomUUID } from "node:crypto"
import type { AgentEvent } from "@chunky/protocol"
import { runAnthropicAgent } from "./anthropic-runner.ts"
import { anthropicOAuthReady } from "./providers/anthropic-sdk.ts"
import type { AgentSelection } from "./providers/registry.ts"

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`)
}

if (!anthropicOAuthReady()) {
  throw new Error("Claude subscription OAuth is not ready. Run `claude auth login --claudeai` first.")
}

const sessionId = randomUUID()
const selection: AgentSelection = Object.freeze({ provider: "anthropic", model: "sonnet", effort: "low" })
const events: AgentEvent[] = []
const emit = (event: AgentEvent) => {
  events.push(event)
  if (event.type === "message.delta") process.stdout.write(event.text)
  if (event.type === "tool.start") console.log(`\n[tool] ${event.name}`)
  if (event.type === "error") console.error(`\n[error] ${event.message}`)
}

console.log(`OAuth SDK session: ${sessionId}`)
const first = await runAnthropicAgent({
  selection,
  threadId: sessionId,
  prompt: "Use the read tool to read package.json. Reply with only the package name from that file.",
  emit,
})
console.log("\n")
assert(events.some((event) => event.type === "tool.start" && event.name === "read"), "Claude did not call Chunky's read tool")
assert(first.includes("chunky-cli"), `first reply did not contain package name: ${first}`)

const toolCountAfterFirst = events.filter((event) => event.type === "tool.start").length
const second = await runAnthropicAgent({
  selection,
  threadId: sessionId,
  prompt: "Without using a tool, reply with only the package name you read in the previous turn.",
  emit,
})
console.log("\n")
assert(second.includes("chunky-cli"), `resumed reply lost prior context: ${second}`)
assert(
  events.filter((event) => event.type === "tool.start").length === toolCountAfterFirst,
  "second turn unexpectedly used a tool instead of resumed context",
)

console.log("PASS: live Claude OAuth used the Agent SDK, Chunky's read tool, Chunky's prompt, and session resume")
