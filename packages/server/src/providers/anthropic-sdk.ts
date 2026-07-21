// This provider deliberately has no LangChain model: the Agent SDK owns the loop.
import type {
  ModelInfo as AnthropicModelInfo,
  Options as AnthropicOptions,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk"
import type { LoginInitiation, ProviderDef } from "./registry.ts"
import type { ModelInfo } from "./models-catalog.ts"
import { CHUNKY_USER_AGENT } from "./app-info.ts"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"

interface ClaudeAuthStatus {
  loggedIn?: boolean
  authMethod?: string
  subscriptionType?: string
  apiProvider?: string
}
export type ClaudeCredentialState = "ready" | "maybe" | "missing"
export interface ClaudeCredentialDetection { state: ClaudeCredentialState; detail: string }

export const ANTHROPIC_SDK_ISOLATION_OPTIONS = {
  tools: [],
  settingSources: [],
  strictMcpConfig: true,
  permissionMode: "dontAsk",
} satisfies Pick<AnthropicOptions, "tools" | "settingSources" | "strictMcpConfig" | "permissionMode">

/** Best effort only: never exposes credential contents or throws. */
export function detectClaudeCredentials(options: { home?: string } = {}): ClaudeCredentialDetection {
  try {
    // An injected home is an isolated test/embedding scope; never consult the
    // user's global CLI session in that mode.
    if (options.home) {
      const credentials = `${options.home}/.claude/.credentials.json`
      if (existsSync(credentials)) return { state: "ready", detail: "Claude Code credentials file was found." }
      if (existsSync(`${options.home}/.claude.json`)) return { state: "maybe", detail: "Claude Code configuration was found; login could not be confirmed." }
      return { state: "missing", detail: "No Claude Code login credentials were detected." }
    }
    if (!options.home && process.env.CLAUDE_CODE_OAUTH_TOKEN) return { state: "ready", detail: "Claude OAuth token is available." }
    const home = options.home ?? homedir()
    const credentials = `${home}/.claude/.credentials.json`
    if (existsSync(credentials)) return { state: "ready", detail: "Claude Code credentials file was found." }
    if (process.platform === "darwin") {
      try {
        const result = Bun.spawnSync(["security", "find-generic-password", "-s", "Claude Code-credentials"], { stdout: "ignore", stderr: "ignore" })
        if (result.exitCode === 0) return { state: "ready", detail: "Claude Code credentials were found in the macOS keychain." }
      } catch { /* security unavailable */ }
    }
    if (existsSync(`${home}/.claude.json`)) return { state: "maybe", detail: "Claude Code configuration was found; login could not be confirmed." }
    return { state: "missing", detail: "No Claude Code login credentials were detected." }
  } catch { return { state: "missing", detail: "Claude Code login status could not be determined." } }
}

const AUTH_STATUS_TTL_MS = 1_000
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
export function anthropicOAuthEnvironment(): Record<string, string | undefined> {
  const environment: Record<string, string | undefined> = {
    ...process.env,
    CLAUDE_AGENT_SDK_CLIENT_APP: CHUNKY_USER_AGENT,
  }
  for (const name of NON_OAUTH_ENVIRONMENT) environment[name] = undefined
  return environment
}

function claudeAuthStatus(): ClaudeAuthStatus | undefined {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    return { loggedIn: true, authMethod: "oauth-token", apiProvider: "firstParty" }
  }
  if (cachedAuth && cachedAuth.expiresAt > Date.now()) return cachedAuth.value
  let value: ClaudeAuthStatus | undefined
  try {
    const proc = Bun.spawnSync(["claude", "auth", "status", "--json"], {
      env: anthropicOAuthEnvironment(),
      stdout: "pipe",
      stderr: "ignore",
    })
    if (proc.exitCode === 0) value = JSON.parse(new TextDecoder().decode(proc.stdout)) as ClaudeAuthStatus
  } catch {
    value = undefined
  }
  cachedAuth = { value, expiresAt: Date.now() + AUTH_STATUS_TTL_MS }
  return value
}

export function anthropicOAuthReady(): boolean {
  const status = claudeAuthStatus()
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

async function loginWithClaudeOAuth(): Promise<LoginInitiation> {
  if (anthropicOAuthReady()) {
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

  try {
    const proc = Bun.spawn(["claude", "auth", "login", "--claudeai"], {
      env: anthropicOAuthEnvironment(),
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
  login: loginWithClaudeOAuth,
}
