// This provider deliberately has no LangChain model: the Agent SDK owns the loop.
import type {
  ModelInfo as AnthropicModelInfo,
  Options as AnthropicOptions,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk"
import type { LoginInitiation, ProviderDef } from "./registry.ts"
import type { ModelInfo } from "./models-catalog.ts"
import { CHUNKY_USER_AGENT } from "./app-info.ts"

interface ClaudeAuthStatus {
  loggedIn?: boolean
  authMethod?: string
  subscriptionType?: string
  apiProvider?: string
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

async function listAnthropicModels(): Promise<ModelInfo[]> {
  if (!anthropicOAuthReady()) {
    throw new Error("anthropic: Claude OAuth is not ready (run `claude auth login --claudeai`)")
  }

  // supportedModels() is an SDK control request. It initializes the real
  // bundled Claude runtime but sends no inference request before we close it.
  const { query } = await import("@anthropic-ai/claude-agent-sdk")
  async function* noInput(): AsyncGenerator<SDKUserMessage> {}
  const q = query({
    prompt: noInput(),
    options: {
      env: anthropicOAuthEnvironment(),
      systemPrompt: "You are Chunky.",
      tools: [],
      settingSources: [],
      permissionMode: "dontAsk",
    } satisfies AnthropicOptions,
  })
  try {
    return (await q.supportedModels()).map(toModelInfo)
  } finally {
    q.close()
  }
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
  runtime: "anthropic-sdk",
  ready: anthropicOAuthReady,
  listModels: listAnthropicModels,
  login: loginWithClaudeOAuth,
}
