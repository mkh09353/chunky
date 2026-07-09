// A fake agent run so the TUI can be built and demoed with NO server/model.
// Emits a realistic Claude-Code-style stream: running -> assistant tokens ->
// a tool call -> more tokens -> done.
import type { AgentEvent } from "./index.ts"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function* mockRun(userText: string): AsyncGenerator<AgentEvent> {
  const sessionId = "mock-session"
  yield { type: "session.status", sessionId, status: "running" }
  yield { type: "message.start", role: "assistant" }

  const preface = `I'll help you with "${userText}". Let me look at the project first.`
  for (const chunk of chunks(preface)) {
    yield { type: "message.delta", text: chunk }
    await sleep(18)
  }

  const toolId = "tool_1"
  yield { type: "tool.start", id: toolId, name: "list_dir", input: { path: "." } }
  await sleep(350)
  yield { type: "tool.end", id: toolId, ok: true, output: "package.json\nsrc/\nREADME.md" }

  const body = `\n\nFound a Bun project. Here's what I'd do:\n\n1. Wire the provider\n2. Stream events to the TUI\n3. Render it like Claude Code\n\nWant me to start?`
  for (const chunk of chunks(body)) {
    yield { type: "message.delta", text: chunk }
    await sleep(22)
  }

  yield { type: "message.end" }
  yield { type: "session.status", sessionId, status: "idle" }
}

function* chunks(s: string): Generator<string> {
  // token-ish chunking on spaces to mimic streaming
  const parts = s.split(/(\s+)/)
  for (const p of parts) if (p) yield p
}
