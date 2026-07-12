import { describe, expect, test } from "bun:test"
import { bash } from "./bash.ts"

describe("bash timeout", () => {
  test("terminates descendants that inherit the command pipes", async () => {
    const started = Date.now()
    const output = await bash.invoke({ command: "sleep 5 & wait", timeout: 0.1 })

    expect(Date.now() - started).toBeLessThan(2_000)
    expect(String(output)).toContain("timed out after 0.1s")
  })
})
