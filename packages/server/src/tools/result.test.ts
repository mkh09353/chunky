import { describe, expect, test } from "bun:test"
import { asToolRunResult, isToolRunResult, toolResult } from "./result.ts"

describe("ToolRunResult", () => {
  test("normalizes legacy strings and preserves prompt text separately", () => {
    expect(asToolRunResult("hello")).toEqual({ promptText: "hello", ok: true })
  })

  test("accepts structured results without changing prompt text", () => {
    const result = toolResult("short", { raw: { kind: "bash", exitCode: 0 } })
    expect(isToolRunResult(result)).toBe(true)
    expect(result).toEqual({ promptText: "short", raw: { kind: "bash", exitCode: 0 }, ok: true })
  })

  test("normalizes errors as failed prompt text", () => {
    expect(asToolRunResult(new Error("failed"))).toEqual({ promptText: "failed", ok: false })
  })
})
