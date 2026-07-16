import { describe, expect, test } from "bun:test"
import { translateStream } from "./run.ts"

describe("translateStream", () => {
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
