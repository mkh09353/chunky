// This provider deliberately has no LangChain model: the Agent SDK owns the loop.
import type {
  ModelInfo as AnthropicModelInfo,
  Options as AnthropicOptions,
  SDKUserMessage,
  SDKControlGetUsageResponse,
} from "@anthropic-ai/claude-agent-sdk"
import type { ProviderAuthInfo, ProviderAuthState, ProviderQuotaWindow } from "@chunky/protocol"
import type { CollectedProviderQuota } from "./quota-types.ts"
import type { LoginInitiation, ProviderDef } from "./registry.ts"
import { isProviderAuthFailure } from "./auth-error.ts"
import type { ModelInfo } from "./models-catalog.ts"
import { CHUNKY_USER_AGENT } from "./app-info.ts"
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, join } from "node:path"

interface ClaudeAuthStatus {
  loggedIn?: boolean
  authMethod?: string
  subscriptionType?: string
  apiProvider?: string
}
export type ClaudeCredentialState = "ready" | "maybe" | "missing"
export interface ClaudeCredentialDetection { state: ClaudeCredentialState; detail: string }

export interface ClaudeExecutableOptions {
  env?: NodeJS.ProcessEnv
  home?: string
  platform?: NodeJS.Platform
  which?: (command: string) => string | null
  isExecutableFile?: (path: string) => boolean
}

function defaultExecutableCheck(path: string): boolean {
  try { return statSync(path).isFile() && (statSync(path).mode & 0o111) !== 0 } catch { return false }
}

/** Resolve Claude without relying on a shell profile (GUI apps have a sparse PATH). */
export function resolveClaudeExecutable(options: ClaudeExecutableOptions = {}): string | undefined {
  const env = options.env ?? process.env
  const home = options.home ?? homedir()
  const check = options.isExecutableFile ?? defaultExecutableCheck
  const candidates: string[] = []
  if (env.CHUNKY_CLAUDE_PATH) candidates.push(env.CHUNKY_CLAUDE_PATH)
  if (options.which) {
    const fromPath = options.which("claude")
    if (fromPath) candidates.push(fromPath)
  }
  for (const dir of (env.PATH ?? "").split(delimiter).filter(Boolean)) candidates.push(join(dir, "claude"))
  candidates.push(join(home, ".local", "bin", "claude"), join(home, ".claude", "local", "claude"))
  if ((options.platform ?? process.platform) === "darwin") candidates.push("/opt/homebrew/bin/claude", "/usr/local/bin/claude", "/usr/bin/claude")
  const seen = new Set<string>()
  return candidates.find((candidate) => {
    if (seen.has(candidate)) return false
    seen.add(candidate)
    return check(candidate)
  })
}

export const ANTHROPIC_SDK_ISOLATION_OPTIONS = {
  tools: [],
  settingSources: [],
  strictMcpConfig: true,
  permissionMode: "dontAsk",
} satisfies Pick<AnthropicOptions, "tools" | "settingSources" | "strictMcpConfig" | "permissionMode">

/** Best effort only: never exposes credential contents or throws. */
export function detectClaudeCredentials(options: { home?: string; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; keychainLookup?: () => boolean } = {}): ClaudeCredentialDetection {
  try {
    // An injected home is an isolated test/embedding scope; never consult the
    // user's global CLI session in that mode.
    if (options.home) {
      const credentials = `${options.home}/.claude/.credentials.json`
      if (validCredentialsFile(credentials)) return { state: "ready", detail: "Claude Code credentials file was found." }
      if (existsSync(`${options.home}/.claude.json`)) return { state: "maybe", detail: "Claude Code configuration was found; login could not be confirmed." }
      return { state: "missing", detail: "No Claude Code login credentials were detected." }
    }
    if (!options.home && (options.env ?? process.env).CLAUDE_CODE_OAUTH_TOKEN) return { state: "ready", detail: "Claude OAuth token is available." }
    const home = options.home ?? homedir()
    const credentials = `${home}/.claude/.credentials.json`
    if (validCredentialsFile(credentials)) return { state: "ready", detail: "Claude Code credentials file was found." }
    if ((options.platform ?? process.platform) === "darwin") {
      try {
        const found = options.keychainLookup ? options.keychainLookup() : Bun.spawnSync(["security", "find-generic-password", "-s", "Claude Code-credentials"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0
        if (found) return { state: "ready", detail: "Claude Code credentials were found in the macOS keychain." }
      } catch { /* security unavailable */ }
    }
    if (existsSync(`${home}/.claude.json`)) return { state: "maybe", detail: "Claude Code configuration was found; login could not be confirmed." }
    return { state: "missing", detail: "No Claude Code login credentials were detected." }
  } catch { return { state: "missing", detail: "Claude Code login status could not be determined." } }
}

function validCredentialsFile(path: string, now: number = Date.now()): boolean {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown
    if (!value || typeof value !== "object" || Array.isArray(value)) return false
    // Claude Code currently writes its first-party OAuth tokens under this
    // recognizable key. A logged-out CLI can leave the record and its account
    // metadata behind with empty tokens, so don't mistake that stale state for
    // an authenticated subscription. Unknown schemas remain best-effort ready
    // for forward compatibility (and macOS keychain auth is checked separately).
    const oauth = (value as { claudeAiOauth?: unknown }).claudeAiOauth
    if (!oauth || typeof oauth !== "object" || Array.isArray(oauth)) return true
    const { accessToken, refreshToken, expiresAt } = oauth as { accessToken?: unknown; refreshToken?: unknown; expiresAt?: unknown }
    const hasAccess = typeof accessToken === "string" && accessToken.length > 0
    const hasRefresh = typeof refreshToken === "string" && refreshToken.length > 0
    if (hasRefresh) return true // the CLI refreshes an expired access token itself
    if (!hasAccess) return false
    // An access token past its expiry with nothing to refresh it is dead weight.
    if (typeof expiresAt === "number" && Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt <= now) return false
    return true
  } catch { return false }
}

const AUTH_STATUS_TTL_MS = 30_000
const NON_OAUTH_ENVIRONMENT = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CONFIG_DIR",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_PROFILE",
  "ANTHROPIC_UNIX_SOCKET",
  "ANTHROPIC_AWS_API_KEY",
  "ANTHROPIC_AWS_AUTH",
  "ANTHROPIC_AWS_BASE_URL",
  "ANTHROPIC_AWS_WORKSPACE_ID",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_BEDROCK_MANTLE_API_KEY",
  "ANTHROPIC_BEDROCK_MANTLE_BASE_URL",
  "ANTHROPIC_FEDERATION_RULE_ID",
  "ANTHROPIC_FOUNDRY_API_KEY",
  "ANTHROPIC_FOUNDRY_AUTH_TOKEN",
  "ANTHROPIC_FOUNDRY_BASE_URL",
  "ANTHROPIC_FOUNDRY_RESOURCE",
  "ANTHROPIC_IDENTITY_TOKEN",
  "ANTHROPIC_IDENTITY_TOKEN_FILE",
  "ANTHROPIC_ORGANIZATION_ID",
  "ANTHROPIC_SERVICE_ACCOUNT_ID",
  "ANTHROPIC_VERTEX_BASE_URL",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "ANTHROPIC_WORKSPACE_ID",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_GATEWAY",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_VERTEX",
] as const
let cachedAuth: { value: ClaudeAuthStatus | undefined; expiresAt: number } | undefined
let loginProcess: ReturnType<typeof Bun.spawn> | undefined

/** Environment inherited by the SDK/CLI with API-key and cloud-provider paths
 * explicitly removed so the `anthropic` provider always means Claude OAuth. */
export function anthropicOAuthEnvironment(baseEnvironment: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
  const environment: Record<string, string | undefined> = {
    ...baseEnvironment,
    CLAUDE_AGENT_SDK_CLIENT_APP: CHUNKY_USER_AGENT,
  }
  for (const name of NON_OAUTH_ENVIRONMENT) environment[name] = undefined
  return environment
}

export function claudeAuthStatus(options: { executable?: string; env?: NodeJS.ProcessEnv; useCache?: boolean } = {}): ClaudeAuthStatus | undefined {
  const env = options.env ?? process.env
  if (env.CLAUDE_CODE_OAUTH_TOKEN) {
    return { loggedIn: true, authMethod: "oauth-token", apiProvider: "firstParty" }
  }
  if (options.useCache !== false && cachedAuth && cachedAuth.expiresAt > Date.now()) return cachedAuth.value
  const executable = options.executable ?? resolveClaudeExecutable({ env })
  if (!executable) return undefined
  let value: ClaudeAuthStatus | undefined
  try {
    const proc = Bun.spawnSync([executable, "auth", "status", "--json"], {
      env: anthropicOAuthEnvironment(env),
      stdout: "pipe",
      stderr: "ignore",
    })
    if (proc.exitCode === 0) value = JSON.parse(new TextDecoder().decode(proc.stdout)) as ClaudeAuthStatus
  } catch {
    value = undefined
  }
  if (options.useCache !== false) cachedAuth = { value, expiresAt: Date.now() + AUTH_STATUS_TTL_MS }
  return value
}

export function anthropicOAuthReady(options: { env?: NodeJS.ProcessEnv; home?: string; platform?: NodeJS.Platform; executable?: string } = {}): boolean {
  const env = options.env ?? process.env
  const status = claudeAuthStatus({ env, executable: options.executable ?? resolveClaudeExecutable({ env, home: options.home, platform: options.platform, ...(options.home ? { which: () => null } : {}) }), useCache: false })
  if (!status) return detectClaudeCredentials({ env, home: options.home, platform: options.platform }).state === "ready"
  return Boolean(
    status?.loggedIn &&
      (status.authMethod === "claude.ai" || status.authMethod === "oauth-token") &&
      (!status.apiProvider || status.apiProvider === "firstParty"),
  )
}

function toModelInfo(model: AnthropicModelInfo): ModelInfo {
  return {
    id: model.value,
    name: model.displayName || model.value,
    reasoning: model.supportsEffort ?? true,
  }
}

const ANTHROPIC_MODELS_CACHE_TTL_MS = 24 * 60 * 60 * 1000 // 24h
function anthropicModelsCachePath(): string {
  return process.env.CHUNKY_ANTHROPIC_MODELS_CACHE || "anthropic-models-cache.json"
}

// supportedModels() starts the full Agent SDK runtime, so retain it across
// requests and restarts where possible rather than paying that cost repeatedly.
let anthropicModelsInFlight: Promise<ModelInfo[]> | undefined
function readAnthropicModelsCache(): ModelInfo[] | undefined {
  try {
    const parsed = JSON.parse(readFileSync(anthropicModelsCachePath(), "utf8")) as { fetchedAt?: number; payload?: ModelInfo[] }
    if (!Array.isArray(parsed?.payload) || typeof parsed.fetchedAt !== "number") return undefined
    if (Date.now() - parsed.fetchedAt > ANTHROPIC_MODELS_CACHE_TTL_MS) return undefined
    return parsed.payload
  } catch { return undefined }
}
function writeAnthropicModelsCache(payload: ModelInfo[]): void {
  try { writeFileSync(anthropicModelsCachePath(), JSON.stringify({ fetchedAt: Date.now(), payload })) } catch {
    // best-effort; the in-memory memo still serves this process
  }
}
async function queryAnthropicModels(query: typeof import("@anthropic-ai/claude-agent-sdk").query): Promise<ModelInfo[]> {
  async function* noInput(): AsyncGenerator<SDKUserMessage> {}
  const q = query({
    prompt: noInput(),
    options: {
      env: anthropicOAuthEnvironment(),
      systemPrompt: "You are Chunky.",
      ...ANTHROPIC_SDK_ISOLATION_OPTIONS,
    } satisfies AnthropicOptions,
  })
  try { return (await q.supportedModels()).map(toModelInfo) } finally { q.close() }
}

function quotaResetMillis(value: unknown): number | null {
  if (typeof value !== "string") return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function anthropicWindow(value: unknown, kind: "five-hour" | "weekly" | "weekly-model", label: string, model?: string): ProviderQuotaWindow | undefined {
  if (value == null || typeof value !== "object") return undefined
  const record = value as { utilization?: unknown; resets_at?: unknown }
  const usedPercent = typeof record.utilization === "number" && Number.isFinite(record.utilization) ? record.utilization : null
  return { kind, label, usedPercent, resetAt: quotaResetMillis(record.resets_at), ...(model ? { model } : {}) }
}

/** Normalize only the quota fields; session costs and raw provider data never escape. */
export function parseAnthropicQuota(body: SDKControlGetUsageResponse): CollectedProviderQuota {
  if (!body.rate_limits_available) {
    return { status: "unsupported", source: "anthropic-sdk", fetchedAt: Date.now(), windows: [] }
  }
  const limits = body.rate_limits
  if (!limits) return { status: "unsupported", source: "anthropic-sdk", fetchedAt: Date.now(), windows: [] }
  const windows: ProviderQuotaWindow[] = []
  const add = (window: ProviderQuotaWindow | undefined) => { if (window) windows.push(window) }
  add(anthropicWindow(limits.five_hour, "five-hour", "5-hour"))
  add(anthropicWindow(limits.seven_day, "weekly", "Weekly"))
  add(anthropicWindow(limits.seven_day_opus, "weekly-model", "Opus weekly", "opus"))
  add(anthropicWindow(limits.seven_day_sonnet, "weekly-model", "Sonnet weekly", "sonnet"))
  for (const window of limits.model_scoped ?? []) {
    add(anthropicWindow(window, "weekly-model", window.display_name, window.display_name))
  }
  return { status: "available", source: "anthropic-sdk", fetchedAt: Date.now(), windows }
}

export async function fetchAnthropicQuota(dependencies: {
  query?: typeof import("@anthropic-ai/claude-agent-sdk").query
  now?: () => number
} = {}): Promise<CollectedProviderQuota> {
  async function* noInput(): AsyncGenerator<SDKUserMessage> {}
  const query = dependencies.query ?? (await import("@anthropic-ai/claude-agent-sdk")).query
  const q = query({
    prompt: noInput(),
    options: {
      env: anthropicOAuthEnvironment(),
      systemPrompt: "You are Chunky.",
      ...ANTHROPIC_SDK_ISOLATION_OPTIONS,
    } satisfies AnthropicOptions,
  })
  try {
    const result = parseAnthropicQuota(await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET())
    return { ...result, fetchedAt: (dependencies.now ?? Date.now)() }
  } finally {
    q.close()
  }
}

export async function listAnthropicModels(
  dependencies: { query?: typeof import("@anthropic-ai/claude-agent-sdk").query } = {},
): Promise<ModelInfo[]> {
  if (!anthropicOAuthReady()) {
    throw new Error("anthropic: Claude OAuth is not ready (run `claude auth login --claudeai`)")
  }

  // Injected queries are test scopes; don't use the production caches.
  if (dependencies.query) return queryAnthropicModels(dependencies.query)
  if (anthropicModelsInFlight) return anthropicModelsInFlight

  // supportedModels() is an SDK control request. It initializes the real
  // bundled Claude runtime but sends no inference request before we close it.
  const promise = (async () => {
    const disk = readAnthropicModelsCache()
    if (disk) return disk
    const query = (await import("@anthropic-ai/claude-agent-sdk")).query
    const models = await queryAnthropicModels(query)
    writeAnthropicModelsCache(models)
    return models
  })()
  anthropicModelsInFlight = promise
  void promise.catch(() => {
    if (anthropicModelsInFlight === promise) anthropicModelsInFlight = undefined
  })
  return promise
}

// ---------------------------------------------------------------------------
// Verified sign-in state. `ready()` above only proves a credential EXISTS; the
// probe below proves it works (a one-turn Haiku request through the same SDK
// runtime and sanitized environment as real runs). Control requests such as
// accountInfo/usage/supportedModels never fail on a dead token, so a tiny
// inference is the cheapest check that reliably surfaces auth failures.
// ---------------------------------------------------------------------------
const ANTHROPIC_AUTH_OK_TTL_MS = 5 * 60_000
const ANTHROPIC_AUTH_PROBE_TIMEOUT_MS = 15_000
const ANTHROPIC_LOGOUT_TIMEOUT_MS = 10_000

interface AnthropicAuthCache { state: ProviderAuthState; detail?: string; checkedAt?: number }
let anthropicAuth: AnthropicAuthCache = { state: "unknown" }
let anthropicAuthInFlight: Promise<void> | undefined

const AUTH_DETAIL_PREFIXES = [/^Claude Code returned an error result:\s*/i, /^Anthropic (?:request|Agent SDK) failed:\s*/i]
const ASSISTANT_ERROR_DETAILS: Record<string, string> = {
  authentication_failed: "Claude authentication failed — the OAuth session is expired or invalid",
  oauth_org_not_allowed: "This Claude organization is not allowed to use Claude Code OAuth",
}

/** Human detail for an auth failure: SDK codes become sentences, wrapper
 *  prefixes are stripped, and nothing token-like is ever included. */
export function describeAnthropicAuthFailure(text: string): string {
  let detail = text.trim()
  if (ASSISTANT_ERROR_DETAILS[detail]) return ASSISTANT_ERROR_DETAILS[detail]!
  for (const prefix of AUTH_DETAIL_PREFIXES) detail = detail.replace(prefix, "")
  detail = detail.replace(/Not logged in\s*·\s*Please run \/login/i, "Not logged in to Claude")
  return detail || "Claude sign-in is not usable"
}

/** Failures that mean "no credential" rather than "credential no longer works". */
export function anthropicAuthFailureState(detail: string): Extract<ProviderAuthState, "expired" | "missing"> {
  return /not logged in/i.test(detail) ? "missing" : "expired"
}

/** Record a verified auth failure (from the probe or a live run) so status
 *  reports it without another probe. */
export function setAnthropicAuthState(state: ProviderAuthState, detail?: string, now: number = Date.now()): void {
  anthropicAuth = { state, ...(detail ? { detail } : {}), checkedAt: now }
}

/** Forget verification results (after login/logout activity). */
export function resetAnthropicAuthState(): void {
  anthropicAuth = { state: "unknown" }
  cachedAuth = undefined
}

/** Cached verified state; never probes. Unverified states fall back to the
 *  cheap credential-presence check so a fresh server still answers ok/missing. */
export function anthropicAuthInfo(options: { isReady?: () => boolean; now?: () => number } = {}): ProviderAuthInfo {
  const isReady = options.isReady ?? (() => anthropicOAuthReady())
  const cached = anthropicAuth
  const base = { canLogin: true, ...(cached.checkedAt ? { checkedAt: cached.checkedAt } : {}) }
  if (cached.state === "ok" || cached.state === "expired") return { state: cached.state, ...(cached.detail ? { detail: cached.detail } : {}), ...base }
  if (cached.state === "missing") {
    if (!isReady()) return { state: "missing", detail: cached.detail ?? "No Claude sign-in was detected.", ...base }
    // A credential appeared since the last verified failure (e.g. `claude auth
    // login` in a terminal): it exists but hasn't been proven yet.
    return { state: "unknown", detail: "Claude sign-in detected but not verified yet.", ...base }
  }
  if (cached.checkedAt) return { state: "unknown", ...(cached.detail ? { detail: cached.detail } : {}), ...base }
  return isReady()
    ? { state: "ok", canLogin: true }
    : { state: "missing", detail: "No Claude sign-in was detected.", canLogin: true }
}

async function defaultAnthropicAuthProbe(signal: AbortSignal): Promise<void> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk")
  const abortController = new AbortController()
  const onAbort = () => abortController.abort(signal.reason)
  if (signal.aborted) onAbort()
  else signal.addEventListener("abort", onAbort, { once: true })
  const q = query({
    prompt: "Reply with exactly: OK",
    options: {
      env: anthropicOAuthEnvironment(),
      systemPrompt: "You are Chunky's sign-in check. Reply with exactly: OK",
      model: "haiku",
      maxTurns: 1,
      abortController,
      ...ANTHROPIC_SDK_ISOLATION_OPTIONS,
    } satisfies AnthropicOptions,
  })
  // The assistant error code (e.g. `authentication_failed`) arrives before the
  // result, whose text distinguishes "not logged in" from "token invalid" —
  // prefer the result and fall back to the code if the stream ends first.
  let assistantError: string | undefined
  try {
    for await (const message of q) {
      if (message.type === "assistant" && message.error) assistantError = String(message.error)
      if (message.type === "result") {
        // A "success" result with is_error carries the API error text in `result`.
        if (message.subtype === "success" && !message.is_error && !assistantError) return
        const detail = message.subtype === "success" ? (message.is_error ? message.result : "") : message.errors.join("; ")
        throw new Error(detail || assistantError || message.subtype)
      }
    }
    throw new Error(assistantError ?? "Claude sign-in check ended without a result")
  } catch (error) {
    // The SDK may throw its own wrapper after a failed result; keep the most
    // specific text we saw.
    const text = (error as Error)?.message ?? String(error)
    if (assistantError && !isProviderAuthFailure(text)) throw new Error(assistantError)
    throw error
  } finally {
    signal.removeEventListener("abort", onAbort)
    q.close()
  }
}

export interface AnthropicEnsureAuthDependencies {
  /** Real verification; rejects with the SDK/CLI failure text. */
  probe?: (signal: AbortSignal) => Promise<void>
  now?: () => number
  timeoutMs?: number
  /** Ignore the 5-minute success cache (POST /api/auth/anthropic/test). */
  force?: boolean
}

/** Preflight the Claude sign-in. Throws (with a human detail) only on a REAL
 *  auth failure; inconclusive probes (network/timeout/spawn) leave the state
 *  `unknown` and let the run proceed. Success is cached for 5 minutes. */
export async function ensureAnthropicAuth(dependencies: AnthropicEnsureAuthDependencies = {}): Promise<void> {
  const now = dependencies.now ?? Date.now
  if (!dependencies.force && anthropicAuth.state === "ok" && anthropicAuth.checkedAt && now() - anthropicAuth.checkedAt < ANTHROPIC_AUTH_OK_TTL_MS) return
  // No presence check first: the probe itself reports "Not logged in" when no
  // credential exists, and skipping `claude auth status` keeps run start cheap.
  if (anthropicAuthInFlight && !dependencies.force) return anthropicAuthInFlight
  const probe = dependencies.probe ?? defaultAnthropicAuthProbe
  const timeoutMs = dependencies.timeoutMs ?? ANTHROPIC_AUTH_PROBE_TIMEOUT_MS
  const attempt = (async () => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        probe(controller.signal),
        new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(new Error(`Claude sign-in check timed out after ${Math.round(timeoutMs / 1000)}s`)); controller.abort(new Error("timed out")) }, timeoutMs) }),
      ])
      setAnthropicAuthState("ok", undefined, now())
    } catch (error) {
      const text = (error as Error)?.message ?? String(error)
      if (isProviderAuthFailure(text)) {
        const detail = describeAnthropicAuthFailure(text)
        setAnthropicAuthState(anthropicAuthFailureState(detail), detail, now())
        throw new Error(detail)
      }
      // Flaky network, spawn failure, timeout: not evidence about the credential.
      setAnthropicAuthState("unknown", `Claude sign-in could not be verified: ${text}`, now())
    } finally {
      if (timer) clearTimeout(timer)
    }
  })()
  anthropicAuthInFlight = attempt
  try { await attempt } finally { if (anthropicAuthInFlight === attempt) anthropicAuthInFlight = undefined }
}

/** `claude auth logout` (best effort, bounded) and forget the verified state. */
export async function logoutClaudeOAuth(dependencies: { spawn?: typeof Bun.spawn; env?: NodeJS.ProcessEnv; resolveExecutable?: () => string | undefined; timeoutMs?: number } = {}): Promise<void> {
  const env = dependencies.env ?? process.env
  const executable = dependencies.resolveExecutable ? dependencies.resolveExecutable() : resolveClaudeExecutable({ env })
  if (executable) {
    try {
      const proc = (dependencies.spawn ?? Bun.spawn)([executable, "auth", "logout"], {
        env: anthropicOAuthEnvironment(env),
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      })
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        proc.exited,
        new Promise<void>((resolve) => { timer = setTimeout(() => { try { proc.kill() } catch { /* already gone */ } resolve() }, dependencies.timeoutMs ?? ANTHROPIC_LOGOUT_TIMEOUT_MS) }),
      ]).catch(() => undefined)
      if (timer) clearTimeout(timer)
    } catch { /* logout is best effort; the state reset below still applies */ }
  }
  cachedAuth = undefined
  setAnthropicAuthState("missing", "Signed out of Claude.")
}

export async function loginWithClaudeOAuth(dependencies: { spawn?: typeof Bun.spawn; env?: NodeJS.ProcessEnv; home?: string; platform?: NodeJS.Platform; resolveExecutable?: () => string | undefined; isReady?: () => boolean } = {}): Promise<LoginInitiation> {
  const env = dependencies.env ?? process.env
  // A present-but-expired credential still looks "ready" to the presence
  // check; a verified failure must never block re-login.
  const verifiedFailure = anthropicAuth.state === "expired" || anthropicAuth.state === "missing"
  if (!verifiedFailure && (dependencies.isReady ?? (() => anthropicOAuthReady({ env, home: dependencies.home, platform: dependencies.platform })))()) {
    return {
      kind: "ready",
      instructions: "Claude subscription OAuth is already ready. Use /model to select Anthropic.",
    }
  }

  if (loginProcess) {
    return {
      kind: "browser-opened",
      instructions: "Claude subscription OAuth is already in progress. Finish signing in in the browser.",
    }
  }

  const executable = dependencies.resolveExecutable?.() ?? resolveClaudeExecutable({ env, home: dependencies.home, platform: dependencies.platform })
  if (!executable) throw new Error("Could not start Claude OAuth login: Claude executable was not found. Install Claude Code or set CHUNKY_CLAUDE_PATH to its executable.")
  try {
    const proc = (dependencies.spawn ?? Bun.spawn)([executable, "auth", "login", "--claudeai"], {
      env: anthropicOAuthEnvironment(env),
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    })
    loginProcess = proc
    resetAnthropicAuthState()
    void proc.exited.finally(() => {
      if (loginProcess === proc) loginProcess = undefined
      resetAnthropicAuthState()
    })
  } catch (err) {
    throw new Error(`Could not start Claude OAuth login: ${(err as Error).message}`)
  }

  return {
    kind: "browser-opened",
    instructions: "Claude opened its subscription OAuth flow. Finish signing in, then Chunky will detect it.",
  }
}

export const anthropicProvider: ProviderDef = {
  id: "anthropic",
  label: "Anthropic Agent SDK · Claude subscription OAuth",
  billing: "subscription",
  runtime: "anthropic-sdk",
  ready: anthropicOAuthReady,
  listModels: listAnthropicModels,
  ensureAuth: () => ensureAnthropicAuth(),
  authInfo: () => anthropicAuthInfo(),
  login: () => loginWithClaudeOAuth(),
  logout: () => logoutClaudeOAuth(),
}
