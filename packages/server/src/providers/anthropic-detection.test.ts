import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { Options, Query } from "@anthropic-ai/claude-agent-sdk"
import { detectClaudeCredentials, listAnthropicModels } from "./anthropic-sdk.ts"

describe("Claude credential detection", () => {
  test("missing isolated home is non-fatal", () => {
    const home = mkdtempSync(join(tmpdir(), "chunky-claude-test-"))
    const result = detectClaudeCredentials({ home })
    expect(result.state).toBe("missing")
    expect(result.detail).toEqual(expect.any(String))
  })
})

describe("Claude model discovery", () => {
  test("isolates the SDK control query from user and plugin MCP servers", async () => {
    const previousToken = process.env.CLAUDE_CODE_OAUTH_TOKEN
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-oauth-token"
    let options: Options | undefined
    const query = ((request: Parameters<typeof import("@anthropic-ai/claude-agent-sdk").query>[0]) => {
      options = request.options
      return {
        supportedModels: async () => [],
        close() {},
      } as unknown as Query
    }) as typeof import("@anthropic-ai/claude-agent-sdk").query

    try {
      await listAnthropicModels({ query })
      expect(options?.strictMcpConfig).toBe(true)
    } finally {
      if (previousToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = previousToken
    }
  })
})
