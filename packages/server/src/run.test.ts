import { describe, expect, test } from "bun:test"
import { translateStream } from "./run.ts"

describe("translateStream", () => {
  test("rejects a provider stream with no assistant text or tool calls", async () => {
    async function* empty() {}

    await expect(translateStream(empty(), undefined, () => {})).rejects.toThrow(
      "provider returned an empty response",
    )
  })
})
