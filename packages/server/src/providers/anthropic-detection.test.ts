import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { detectClaudeCredentials } from "./anthropic-sdk.ts"

describe("Claude credential detection", () => {
  test("missing isolated home is non-fatal", () => {
    const home = mkdtempSync(join(tmpdir(), "chunky-claude-test-"))
    const result = detectClaudeCredentials({ home })
    expect(result.state).toBe("missing")
    expect(result.detail).toEqual(expect.any(String))
  })
})
