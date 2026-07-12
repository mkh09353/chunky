import { describe, expect, test } from "bun:test"
import { translateStream } from "./run.ts"

describe("translateStream", () => {
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
})
