import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { Options, Query } from "@anthropic-ai/claude-agent-sdk"
import { anthropicOAuthReady, detectClaudeCredentials, listAnthropicModels, loginWithClaudeOAuth, resolveClaudeExecutable } from "./anthropic-sdk.ts"

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

describe("Claude executable resolution and readiness", () => {
  test("prefers an explicit executable override", () => {
    expect(resolveClaudeExecutable({
      env: { CHUNKY_CLAUDE_PATH: "/configured/claude", PATH: "/path/claude" },
      which: () => "/which/claude",
      isExecutableFile: (path) => path === "/configured/claude",
    })).toBe("/configured/claude")
  })

  test("finds an executable in the supplied PATH", () => {
    expect(resolveClaudeExecutable({
      env: { PATH: "/gui/bin" },
      which: () => null,
      isExecutableFile: (path) => path === "/gui/bin/claude",
    })).toBe("/gui/bin/claude")
  })

  test("recognizes a credentials file without an executable", () => {
    const home = mkdtempSync(join(tmpdir(), "chunky-claude-auth-"))
    const credentials = join(home, ".claude")
    mkdirSync(credentials)
    writeFileSync(join(credentials, ".credentials.json"), JSON.stringify({ oauthAccount: { subscriptionType: "pro" } }))
    expect(anthropicOAuthReady({ home, env: { PATH: "" }, platform: "linux", executable: "/missing/claude" })).toBe(true)
  })

  test("does not treat ambiguous config alone as ready", () => {
    const home = mkdtempSync(join(tmpdir(), "chunky-claude-config-"))
    writeFileSync(join(home, ".claude.json"), "{}")
    expect(anthropicOAuthReady({ home, env: { PATH: "" }, platform: "linux", executable: "/missing/claude" })).toBe(false)
  })

  test("login spawns the resolved executable with sanitized OAuth environment", async () => {
    let command: string[] | undefined
    let spawnedEnvironment: Record<string, string | undefined> | undefined
    const spawn = ((args: string[], options: { env?: Record<string, string | undefined> }) => {
      command = args
      spawnedEnvironment = options.env
      return { exited: Promise.resolve(0) } as unknown as ReturnType<typeof Bun.spawn>
    }) as typeof Bun.spawn

    const result = await loginWithClaudeOAuth({
      env: {
        PATH: "/gui/bin",
        CHUNKY_CLAUDE_PATH: "/configured/claude",
        ANTHROPIC_API_KEY: "redacted-test-value",
        ANTHROPIC_AUTH_TOKEN: "redacted-test-value",
        ANTHROPIC_BASE_URL: "https://example.invalid",
        ANTHROPIC_PROFILE: "alternate",
        CLAUDE_CODE_USE_VERTEX: "1",
        KEEP_ME: "yes",
      },
      isReady: () => false,
      resolveExecutable: () => "/absolute/claude",
      spawn,
    })

    expect(result.kind).toBe("browser-opened")
    expect(command).toEqual(["/absolute/claude", "auth", "login", "--claudeai"])
    expect(spawnedEnvironment?.KEEP_ME).toBe("yes")
    expect(spawnedEnvironment?.CLAUDE_AGENT_SDK_CLIENT_APP).toBeTruthy()
    for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_PROFILE", "CLAUDE_CODE_USE_VERTEX"]) {
      expect(spawnedEnvironment?.[name]).toBeUndefined()
    }
  })

  test("reports actionable missing executable login failure", async () => {
    const old = process.env.CHUNKY_CLAUDE_PATH
    const oldPath = process.env.PATH
    const oldToken = process.env.CLAUDE_CODE_OAUTH_TOKEN
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN
    process.env.CHUNKY_CLAUDE_PATH = "/definitely/missing/claude"
    process.env.PATH = ""
    try {
      await expect(loginWithClaudeOAuth({ env: { PATH: "", CHUNKY_CLAUDE_PATH: "/definitely/missing/claude", CLAUDE_CODE_OAUTH_TOKEN: undefined }, home: mkdtempSync(join(tmpdir(), "chunky-claude-login-")), platform: "linux", resolveExecutable: () => undefined, isReady: () => false })).rejects.toThrow("CHUNKY_CLAUDE_PATH")
    } finally {
      if (old === undefined) delete process.env.CHUNKY_CLAUDE_PATH
      else process.env.CHUNKY_CLAUDE_PATH = old
      if (oldPath === undefined) delete process.env.PATH
      else process.env.PATH = oldPath
      if (oldToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = oldToken
    }
  })
})
