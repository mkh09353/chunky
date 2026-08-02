import { expect, test } from "bun:test"
import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages"
import { Store } from "./store.ts"
import { remoteCompactionMiddleware } from "./agent.ts"

function sseResponse(): Response {
  const event = JSON.stringify({ type: "response.output_item.done", item: { type: "compaction", encrypted_content: "abc" } })
  return new Response(`event: response.output_item.done\ndata: ${event}\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } })
}

test("remote compaction middleware captures, persists once, and skips non-Codex", async () => {
  const sessionId = `remote-compaction-${crypto.randomUUID()}`
  Store.createSession(sessionId)
  const summary = new SystemMessage({ id: "summary-1", content: "portable summary boundary", additional_kwargs: { lc_source: "summarization" } })
  const before = [new HumanMessage("old context"), new AIMessage("old answer")]
  let calls = 0
  const fetchStub = async () => { calls++; return sseResponse() }
  const middleware = remoteCompactionMiddleware("codex", "gpt-5.6-sol", { sessionId, fetch: fetchStub as typeof fetch })

  await middleware.beforeModel({ messages: before })
  await middleware.afterModel({ messages: [summary] }, { configurable: { thread_id: sessionId } })
  await middleware.drain()
  expect(calls).toBe(1)
  expect(Store.getCompactionArtifact(sessionId)).toMatchObject({ provider: "codex", model: "gpt-5.6-sol", boundary: "portable summary boundary", replacementHistory: [{ type: "compaction", encrypted_content: "abc" }] })

  await middleware.afterModel({ messages: [summary] }, { configurable: { thread_id: sessionId } })
  await middleware.drain()
  expect(calls).toBe(1)

  let nonCodexCalls = 0
  const otherFetch = (async () => { nonCodexCalls++; return sseResponse() }) as typeof fetch
  const other = remoteCompactionMiddleware("openai", "gpt-5", { sessionId, fetch: otherFetch })
  await other.beforeModel({ messages: before })
  await other.afterModel({ messages: [summary] }, { configurable: { thread_id: sessionId } })
  await other.drain()
  expect(nonCodexCalls).toBe(0)
})
