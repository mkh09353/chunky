import { expect, test } from "bun:test"
import { composePortablePrompt, formatPortableHandoff, incompatibleConversationRuntime } from "./portable-handoff.ts"

const row = (event: any) => ({ event })
const transcript = [
  row({ type: "message.user", text: "old question" }),
  row({ type: "message.start", role: "assistant" }), row({ type: "message.delta", text: "old answer" }), row({ type: "message.end" }),
]

test("composes the actual LangGraph to Anthropic prompt", () => {
  const prompt = composePortablePrompt("new request", "langgraph", "anthropic-sdk", transcript)
  expect(prompt).toContain("old question")
  expect(prompt).toContain("old answer")
  expect(prompt.endsWith("\n\nnew request")).toBe(true)
})

test("composes the actual Anthropic to LangGraph prompt", () => {
  const prompt = composePortablePrompt("continue", "anthropic-sdk", "langgraph", transcript)
  expect(prompt).toContain("old question")
  expect(prompt.endsWith("\n\ncontinue")).toBe(true)
})

test("same runtime and missing usage preserve the exact prompt", () => {
  expect(composePortablePrompt("same", "langgraph", "langgraph", transcript)).toBe("same")
  expect(composePortablePrompt("first", undefined, "anthropic-sdk", transcript)).toBe("first")
})

test("filters child/tool events and includes current user text exactly once", () => {
  const events = [
    row({ type: "message.user", text: "new request" }),
    row({ type: "message.start", role: "assistant" }), row({ type: "message.delta", text: "earlier response" }), row({ type: "message.end" }),
    ...transcript,
    row({ type: "message.user", text: "new request" }),
    row({ type: "message.user", text: "child secret", threadId: "child" }),
    row({ type: "tool.start", id: "tool", name: "bash" }),
  ]
  const prompt = composePortablePrompt("new request", "langgraph", "anthropic-sdk", events)
  // The prior identical request remains quoted; only the newly persisted copy
  // is removed before the actual current prompt is appended.
  expect(prompt.match(/new request/g)?.length).toBe(2)
  expect(prompt).toContain("earlier response")
  expect(prompt).not.toContain("child secret")
  expect(prompt).not.toContain("tool")
})

test("is bounded, tails ten messages, and discloses omission", () => {
  const events = Array.from({ length: 14 }, (_, i) => row({ type: "message.user", text: `message-${i}-${"x".repeat(2000)}` }))
  const result = formatPortableHandoff(events)!
  expect(result.length).toBeLessThanOrEqual(14_000)
  expect(result).toContain("message-13")
  expect(result).toContain("omitted")
})

test("detects only cross-runtime transitions", () => {
  expect(incompatibleConversationRuntime("anthropic-sdk", "langgraph")).toBe(true)
  expect(incompatibleConversationRuntime("langgraph", "anthropic-sdk")).toBe(true)
  expect(incompatibleConversationRuntime("langgraph", "langgraph")).toBe(false)
  expect(incompatibleConversationRuntime(undefined, "langgraph")).toBe(false)
})
