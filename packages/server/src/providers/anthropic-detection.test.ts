import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { Options, Query } from "@anthropic-ai/claude-agent-sdk"
import {
  anthropicAuthInfo,
  anthropicOAuthReady,
  describeAnthropicAuthFailure,
  detectClaudeCredentials,
  ensureAnthropicAuth,
  listAnthropicModels,
  loginWithClaudeOAuth,
  logoutClaudeOAuth,
  resetAnthropicAuthState,
  resolveClaudeExecutable,
  setAnthropicAuthState,
} from "./anthropic-sdk.ts"
import { isProviderAuthFailure } from "./auth-error.ts"

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

  test("does not treat an empty Claude OAuth record as ready", () => {
    const home = mkdtempSync(join(tmpdir(), "chunky-claude-stale-auth-"))
    const credentials = join(home, ".claude")
    mkdirSync(credentials)
    writeFileSync(join(credentials, ".credentials.json"), JSON.stringify({
      claudeAiOauth: { accessToken: "", refreshToken: "", expiresAt: 0, subscriptionType: "pro" },
    }))
    expect(anthropicOAuthReady({ home, env: { PATH: "" }, platform: "linux", executable: "/missing/claude" })).toBe(false)
  })

  test("recognizes a token-bearing Claude OAuth record without an executable", () => {
    const home = mkdtempSync(join(tmpdir(), "chunky-claude-valid-auth-"))
    const credentials = join(home, ".claude")
    mkdirSync(credentials)
    writeFileSync(join(credentials, ".credentials.json"), JSON.stringify({
      claudeAiOauth: { accessToken: "redacted-test-token", refreshToken: "", expiresAt: 0 },
    }))
    expect(anthropicOAuthReady({ home, env: { PATH: "" }, platform: "linux", executable: "/missing/claude" })).toBe(true)
  })

  test("an access token past expiresAt with no refresh token is not ready", () => {
    const home = mkdtempSync(join(tmpdir(), "chunky-claude-expired-auth-"))
    const credentials = join(home, ".claude")
    mkdirSync(credentials)
    writeFileSync(join(credentials, ".credentials.json"), JSON.stringify({
      claudeAiOauth: { accessToken: "redacted-test-token", refreshToken: "", expiresAt: Date.now() - 60_000 },
    }))
    expect(anthropicOAuthReady({ home, env: { PATH: "" }, platform: "linux", executable: "/missing/claude" })).toBe(false)
    expect(detectClaudeCredentials({ home }).state).toBe("missing")
  })

  test("an expired access token with a refresh token stays ready (the CLI refreshes it)", () => {
    const home = mkdtempSync(join(tmpdir(), "chunky-claude-refreshable-auth-"))
    const credentials = join(home, ".claude")
    mkdirSync(credentials)
    writeFileSync(join(credentials, ".credentials.json"), JSON.stringify({
      claudeAiOauth: { accessToken: "redacted-test-token", refreshToken: "redacted-test-refresh", expiresAt: Date.now() - 60_000 },
    }))
    expect(anthropicOAuthReady({ home, env: { PATH: "" }, platform: "linux", executable: "/missing/claude" })).toBe(true)
  })

  test("a future expiresAt keeps an access-token-only record ready", () => {
    const home = mkdtempSync(join(tmpdir(), "chunky-claude-fresh-auth-"))
    const credentials = join(home, ".claude")
    mkdirSync(credentials)
    writeFileSync(join(credentials, ".credentials.json"), JSON.stringify({
      claudeAiOauth: { accessToken: "redacted-test-token", refreshToken: "", expiresAt: Date.now() + 60 * 60_000 },
    }))
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

describe("Claude auth failure classification", () => {
  test("matches SDK auth codes and CLI sign-in failures only", () => {
    for (const text of [
      "authentication_failed",
      "oauth_org_not_allowed",
      "Claude Code returned an error result: Failed to authenticate. API Error: 401 OAuth access token is invalid.",
      "Claude Code returned an error result: Not logged in · Please run /login",
      "Failed to authenticate: OAuth session expired and could not be refreshed",
      "Login expired",
      "invalid access token",
    ]) expect(isProviderAuthFailure(text)).toBe(true)
    for (const text of [
      "rate_limit",
      "overloaded",
      "fetch failed",
      "API Error: 400 invalid_request_error: prompt is too long: 250000 tokens > 200000 maximum",
      "API Error: 429 rate limited",
      "Claude sign-in check timed out after 15s",
      "model_not_found",
    ]) expect(isProviderAuthFailure(text)).toBe(false)
  })

  test("describes failures as human text without wrapper prefixes", () => {
    expect(describeAnthropicAuthFailure("authentication_failed")).toContain("expired or invalid")
    expect(describeAnthropicAuthFailure("Claude Code returned an error result: Failed to authenticate. API Error: 401 OAuth access token is invalid.")).toBe("Failed to authenticate. API Error: 401 OAuth access token is invalid.")
    expect(describeAnthropicAuthFailure("Claude Code returned an error result: Not logged in · Please run /login")).toBe("Not logged in to Claude")
  })
})

describe("Claude verified auth state", () => {
  beforeEach(() => resetAnthropicAuthState())
  afterEach(() => resetAnthropicAuthState())

  test("a successful probe is cached for five minutes and re-probed after", async () => {
    let now = 1_000_000
    let probes = 0
    const probe = async () => { probes++ }
    await ensureAnthropicAuth({ probe, now: () => now })
    expect(probes).toBe(1)
    expect(anthropicAuthInfo({ isReady: () => false })).toEqual({ state: "ok", canLogin: true, checkedAt: 1_000_000 })

    now += 4 * 60_000
    await ensureAnthropicAuth({ probe, now: () => now })
    expect(probes).toBe(1)

    now += 2 * 60_000
    await ensureAnthropicAuth({ probe, now: () => now })
    expect(probes).toBe(2)
    expect(anthropicAuthInfo().checkedAt).toBe(now)

    // /test bypasses the success cache.
    await ensureAnthropicAuth({ probe, now: () => now, force: true })
    expect(probes).toBe(3)
  })

  test("an auth failure throws the human detail and is remembered as expired", async () => {
    const probe = async () => { throw new Error("Claude Code returned an error result: Failed to authenticate: OAuth session expired and could not be refreshed") }
    await expect(ensureAnthropicAuth({ probe, now: () => 5 })).rejects.toThrow("OAuth session expired and could not be refreshed")
    const info = anthropicAuthInfo({ isReady: () => true })
    expect(info.state).toBe("expired")
    expect(info.detail).toBe("Failed to authenticate: OAuth session expired and could not be refreshed")
    expect(info.checkedAt).toBe(5)
    expect(info.canLogin).toBe(true)
    // A verified failure is re-probed on the next preflight (no failure cache
    // blocks a user who re-authenticated out of band).
    let probes = 0
    await ensureAnthropicAuth({ probe: async () => { probes++ }, now: () => 6 })
    expect(probes).toBe(1)
    expect(anthropicAuthInfo().state).toBe("ok")
  })

  test("a not-logged-in failure is remembered as missing", async () => {
    await expect(ensureAnthropicAuth({ probe: async () => { throw new Error("Claude Code returned an error result: Not logged in · Please run /login") }, now: () => 7 })).rejects.toThrow("Not logged in to Claude")
    expect(anthropicAuthInfo({ isReady: () => false })).toMatchObject({ state: "missing", checkedAt: 7 })
    // A credential that appeared since is reported as unverified, not missing.
    expect(anthropicAuthInfo({ isReady: () => true }).state).toBe("unknown")
  })

  test("network, timeout and spawn failures never mark the sign-in expired and never block the run", async () => {
    await ensureAnthropicAuth({ probe: async () => { throw new Error("fetch failed") }, now: () => 9 })
    expect(anthropicAuthInfo({ isReady: () => true })).toMatchObject({ state: "unknown", checkedAt: 9 })
    expect(anthropicAuthInfo().detail).toContain("fetch failed")

    let aborted = false
    await ensureAnthropicAuth({
      probe: (signal) => new Promise((_, reject) => { signal.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")) }) }),
      now: () => 10,
      timeoutMs: 20,
    })
    expect(aborted).toBe(true)
    expect(anthropicAuthInfo().state).toBe("unknown")
    expect(anthropicAuthInfo().detail).toContain("timed out")
  })

  test("unverified state falls back to credential presence", () => {
    expect(anthropicAuthInfo({ isReady: () => true })).toEqual({ state: "ok", canLogin: true })
    expect(anthropicAuthInfo({ isReady: () => false })).toMatchObject({ state: "missing", canLogin: true })
  })

  test("login is not short-circuited by a present-but-expired credential and resets verified state", async () => {
    setAnthropicAuthState("expired", "OAuth session expired", 1)
    let exited: (code: number) => void = () => {}
    const spawn = (() => ({ exited: new Promise<number>((resolve) => { exited = resolve }) }) as unknown as ReturnType<typeof Bun.spawn>) as typeof Bun.spawn
    const result = await loginWithClaudeOAuth({ env: { PATH: "" }, isReady: () => true, resolveExecutable: () => "/absolute/claude", spawn })
    expect(result.kind).toBe("browser-opened")
    expect(anthropicAuthInfo({ isReady: () => true })).toEqual({ state: "ok", canLogin: true })
    exited(0)
    await Bun.sleep(1)
    // Without a verified failure, a ready credential still short-circuits.
    expect((await loginWithClaudeOAuth({ env: { PATH: "" }, isReady: () => true, resolveExecutable: () => "/absolute/claude", spawn })).kind).toBe("ready")
  })

  test("logout runs `claude auth logout` with the sanitized environment and reports missing", async () => {
    setAnthropicAuthState("ok", undefined, 1)
    let command: string[] | undefined
    let spawnedEnvironment: Record<string, string | undefined> | undefined
    const spawn = ((args: string[], options: { env?: Record<string, string | undefined> }) => {
      command = args
      spawnedEnvironment = options.env
      return { exited: Promise.resolve(0), kill() {} } as unknown as ReturnType<typeof Bun.spawn>
    }) as typeof Bun.spawn
    await logoutClaudeOAuth({ env: { PATH: "", ANTHROPIC_API_KEY: "redacted-test-value" }, resolveExecutable: () => "/absolute/claude", spawn })
    expect(command).toEqual(["/absolute/claude", "auth", "logout"])
    expect(spawnedEnvironment?.ANTHROPIC_API_KEY).toBeUndefined()
    expect(anthropicAuthInfo({ isReady: () => false })).toMatchObject({ state: "missing", detail: "Signed out of Claude." })
  })

  test("logout tolerates a hung or missing executable", async () => {
    setAnthropicAuthState("ok", undefined, 1)
    let killed = false
    const spawn = (() => ({ exited: new Promise<number>(() => {}), kill() { killed = true } }) as unknown as ReturnType<typeof Bun.spawn>) as typeof Bun.spawn
    await logoutClaudeOAuth({ env: { PATH: "" }, resolveExecutable: () => "/absolute/claude", spawn, timeoutMs: 10 })
    expect(killed).toBe(true)
    expect(anthropicAuthInfo({ isReady: () => false }).state).toBe("missing")
    await logoutClaudeOAuth({ env: { PATH: "" }, resolveExecutable: () => undefined })
    expect(anthropicAuthInfo({ isReady: () => false }).state).toBe("missing")
  })
})
