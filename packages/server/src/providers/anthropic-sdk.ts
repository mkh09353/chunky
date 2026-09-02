// This provider deliberately has no LangChain model: the Agent SDK owns the loop.
import type {
  ModelInfo as AnthropicModelInfo,
  Options as AnthropicOptions,
  SDKUserMessage,
  SDKControlGetUsageResponse,
} from "@anthropic-ai/claude-agent-sdk"
import type { ProviderQuotaWindow } from "@chunky/protocol"
import type { CollectedProviderQuota } from "./quota-types.ts"
import type { LoginInitiation, ProviderDef } from "./registry.ts"
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

function validCredentialsFile(path: string): boolean {
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
    const { accessToken, refreshToken } = oauth as { accessToken?: unknown; refreshToken?: unknown }
    return (typeof accessToken === "string" && accessToken.length > 0) ||
      (typeof refreshToken === "string" && refreshToken.length > 0)
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

export async function loginWithClaudeOAuth(dependencies: { spawn?: typeof Bun.spawn; env?: NodeJS.ProcessEnv; home?: string; platform?: NodeJS.Platform; resolveExecutable?: () => string | undefined; isReady?: () => boolean } = {}): Promise<LoginInitiation> {
  const env = dependencies.env ?? process.env
  if ((dependencies.isReady ?? (() => anthropicOAuthReady({ env, home: dependencies.home, platform: dependencies.platform })))()) {
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
    cachedAuth = undefined
    void proc.exited.finally(() => {
      if (loginProcess === proc) loginProcess = undefined
      cachedAuth = undefined
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
  login: () => loginWithClaudeOAuth(),
}
