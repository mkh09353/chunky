import { describe, expect, test } from "bun:test"
import { mergeInterjectionBoundaries, onFirstStreamChunk, runAgent, translateStream } from "./run.ts"
import { appendTaskOutput, createTask, finishTask, peekTaskReminders, resetTasks, taskSpillPath } from "./tasks.ts"
import { getProvider, registerProvider } from "./providers/registry.ts"
import { Store } from "./store.ts"

describe("translateStream", () => {
  test("submission callback waits for the first provider stream chunk", async () => {
    let submitted = false
    async function* failed() { throw new Error("failed before first chunk") }
    await expect(async () => {
      for await (const _ of onFirstStreamChunk(failed(), () => { submitted = true })) { /* empty */ }
    }).toThrow("failed before first chunk")
    expect(submitted).toBe(false)

    async function* started() { yield "first"; yield "second" }
    const chunks: string[] = []
    for await (const chunk of onFirstStreamChunk(started(), () => { submitted = true })) chunks.push(chunk)
    expect(submitted).toBe(true)
    expect(chunks).toEqual(["first", "second"])
  })

  test("successive boundaries append undelivered interjections in FIFO order", () => {
    const pending = { prompts: ["a1", "a2"], texts: ["A1", "A2"], images: [undefined, [{ mediaType: "image/png", base64: "a" }]] }
    const next = { prompts: ["b1"], texts: ["B1"], images: [[{ mediaType: "image/png", base64: "b" }]] }
    expect(mergeInterjectionBoundaries(pending, next)).toEqual({
      prompts: ["a1", "a2", "b1"],
      texts: ["A1", "A2", "B1"],
      images: [undefined, [{ mediaType: "image/png", base64: "a" }], [{ mediaType: "image/png", base64: "b" }]],
    })
  })

  test("main-thread tool boundary emits tool.end then raises controlled boundary", async () => {
    const events: any[] = []
    const boundary = { prompts: ["wrapped"], texts: ["raw"], images: [undefined] }
    async function* stream() { yield ["updates", { tools: { messages: [{ type: "tool", tool_call_id: "x", content: "ok" }] } }] }
    await expect(translateStream(stream(), undefined, (e) => events.push(e), undefined, () => boundary)).rejects.toMatchObject({ name: "InterjectionBoundary" })
    expect(events.at(-1)).toMatchObject({ type: "tool.end", id: "x" })
  })

  test("child-thread tool boundaries never invoke the main boundary callback", async () => {
    let called = false
    async function* stream() {
      yield ["updates", { tools: { messages: [{ type: "tool", tool_call_id: "x", content: "ok" }] } }]
    }
    await translateStream(stream(), "child", () => {}, undefined, () => { called = true; return { prompts: ["x"], texts: ["x"], images: [undefined] } })
    expect(called).toBe(false)
  })
  test("surfaces output-limit completion distinctly", async () => {
    const events: any[] = []
    async function* limited() {
      yield ["messages", [{ type: "ai", content: "partial" }, {}]]
      yield ["updates", { model: { messages: [{ type: "ai", content: "partial", response_metadata: { finish_reason: "length" } }] } }]
    }
    await translateStream(limited(), undefined, (event) => events.push(event))
    expect(events).toContainEqual({ type: "message.end", reason: "max_tokens" })
  })

  test("rejects a provider stream with no assistant text or tool calls", async () => {
    async function* empty() {}

    await expect(translateStream(empty(), undefined, () => {})).rejects.toThrow(
      "provider returned an empty response",
    )
  })

  test("emits structured tool raw while keeping output equal to prompt text", async () => {
    const events: any[] = []
    async function* withToolResult() {
      yield ["updates", {
        tools: {
          messages: [{
            type: "tool",
            tool_call_id: "call-1",
            content: "concise model text",
            artifact: {
              promptText: "concise model text",
              raw: { kind: "bash", exitCode: 0 },
              ok: true,
            },
          }],
        },
      }]
      yield ["updates", { model: { messages: [{ type: "ai", content: "done" }] } }]
    }

    await translateStream(withToolResult(), undefined, (event) => events.push(event))

    expect(events).toContainEqual({
      type: "tool.end",
      id: "call-1",
      ok: true,
      output: "concise model text",
      raw: { kind: "bash", exitCode: 0 },
    })
    expect(events.find((event) => event.type === "tool.end")?.output).not.toContain("exitCode")
  })
})

test("failed provider preflight leaves background-task reminders pending", async () => {
  const sessionId = `preflight-reminder-${process.pid}`
  const originalProvider = getProvider("grok")!
  registerProvider({
    id: "grok",
    label: "Test preflight failure",
    billing: "unknown",
    ready: () => true,
    listModels: async () => [],
    buildModel: () => { throw new Error("model construction must not run") },
    ensureAuth: async () => { throw new Error("expired") },
  })
  Store.createSession(sessionId)
  Store.pinSelection(sessionId, { provider: "grok", model: "test" })
  const proc = Bun.spawn(["bash", "-lc", "true"], { stdout: "pipe", stderr: "pipe" })
  const task = createTask(sessionId, { command: "true", process: proc, spillPath: taskSpillPath(sessionId) })
  appendTaskOutput(task, "done")
  finishTask(task, 0)

  try {
    await runAgent(sessionId, "hello", () => {})
    expect(peekTaskReminders(sessionId).ids).toEqual([task.taskId])
  } finally {
    Store.pinSelection(sessionId, null)
    registerProvider(originalProvider)
    await resetTasks()
  }
})
