// Codex / ChatGPT subscription provider, ported best-effort from opencode's
// packages/opencode/src/plugin/openai/codex.ts.
//
// CAVEAT (read before relying on this): ChatGPT's Codex backend speaks the
// OpenAI *Responses* API at https://chatgpt.com/backend-api/codex/responses,
// NOT the chat-completions API that ChatOpenAI emits. opencode gets the
// responses-shaped request from the Vercel AI SDK's responses transport; we
// only have LangChain's ChatOpenAI (chat-completions shaped). So the OAuth,
// token refresh, account-id header, and URL routing are all ported faithfully
// and testable, but a real end-to-end chat turn will likely need a
// responses-API request body that ChatOpenAI does not produce. This is wired
// as the same registry pattern so it can be finished by swapping the model for
// a responses-capable client without touching the auth plumbing. See the
// integrator notes in the task report.
import type { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { ChatOpenAI } from "@langchain/openai"
import { createServer } from "node:http"
import { AuthStore, type OAuthInfo } from "./auth-store.ts"
import type { LoginInitiation, ProviderDef } from "./registry.ts"
import { enrichModels, type ModelInfo } from "./models-catalog.ts"
import { chatOptionsFor } from "./model-options.ts"
import type { ModelSelection } from "../settings.ts"

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
const ISSUER = "https://auth.openai.com"
const CODEX_API_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses"
const OAUTH_PORT = 1455
const OAUTH_REDIRECT_PATH = "/auth/callback"
const REDIRECT_URI = `http://localhost:${OAUTH_PORT}${OAUTH_REDIRECT_PATH}`
const OAUTH_POLLING_SAFETY_MARGIN_MS = 3_000
const DEFAULT_MODEL = process.env.CODEX_MODEL || "gpt-5.5"

// Curated Codex models (gpt-5.x + gpt-5.x-codex reasoning family), mirroring
// opencode's ALLOWED_MODELS plus the codex variants. Enriched from models.dev.
const CODEX_MODELS = [
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex",
  "gpt-5.3-codex-spark",
  "gpt-5.2-codex",
  "gpt-5.1-codex",
]
const USER_AGENT = "multicode-cli/0.0.0"

const ACCESS_TOKEN_REFRESH_SKEW_MS = 60_000

interface PkceCodes {
  verifier: string
  challenge: string
}

interface TokenResponse {
  id_token?: string
  access_token: string
  refresh_token: string
  expires_in?: number
}

function base64UrlEncode(buffer: ArrayBuffer): string {
  const binary = String.fromCharCode(...new Uint8Array(buffer))
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

async function generatePKCE(): Promise<PkceCodes> {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
  const verifier = Array.from(crypto.getRandomValues(new Uint8Array(43)))
    .map((b) => chars[b % chars.length])
    .join("")
  const challenge = base64UrlEncode(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)))
  return { verifier, challenge }
}

// ---------- account id extraction from the JWT ----------

interface IdTokenClaims {
  chatgpt_account_id?: string
  organizations?: Array<{ id: string }>
  email?: string
  "https://api.openai.com/auth"?: { chatgpt_account_id?: string }
}

function parseJwtClaims(token: string): IdTokenClaims | undefined {
  const parts = token.split(".")
  if (parts.length !== 3) return undefined
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString())
  } catch {
    return undefined
  }
}

function extractAccountIdFromClaims(claims: IdTokenClaims): string | undefined {
  return (
    claims.chatgpt_account_id ||
    claims["https://api.openai.com/auth"]?.chatgpt_account_id ||
    claims.organizations?.[0]?.id
  )
}

function extractAccountId(tokens: TokenResponse): string | undefined {
  if (tokens.id_token) {
    const claims = parseJwtClaims(tokens.id_token)
    const accountId = claims && extractAccountIdFromClaims(claims)
    if (accountId) return accountId
  }
  if (tokens.access_token) {
    const claims = parseJwtClaims(tokens.access_token)
    return claims ? extractAccountIdFromClaims(claims) : undefined
  }
  return undefined
}

// ---------- token endpoint calls ----------

function buildAuthorizeUrl(pkce: PkceCodes, state: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: "openid profile email offline_access",
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state,
    originator: "multicode",
  })
  return `${ISSUER}/oauth/authorize?${params.toString()}`
}

async function exchangeCodeForTokens(code: string, pkce: PkceCodes): Promise<TokenResponse> {
  const response = await fetch(`${ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: pkce.verifier,
    }).toString(),
  })
  if (!response.ok) throw new Error(`Codex token exchange failed: ${response.status}`)
  return response.json() as Promise<TokenResponse>
}

async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  const response = await fetch(`${ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }).toString(),
  })
  if (!response.ok) throw new Error(`Codex token refresh failed: ${response.status}`)
  return response.json() as Promise<TokenResponse>
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------- persistence ----------

function persist(tokens: TokenResponse, prevRefresh?: string, prevAccountId?: string): OAuthInfo {
  const accountId = extractAccountId(tokens) || prevAccountId
  const info: OAuthInfo = {
    type: "oauth",
    access: tokens.access_token,
    refresh: tokens.refresh_token || prevRefresh || "",
    expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
    ...(accountId ? { accountId } : {}),
  }
  AuthStore.set("codex", info)
  return info
}

// ---------- single-flight refreshing token getter ----------

let refreshPromise: Promise<OAuthInfo> | undefined

async function validAuth(): Promise<OAuthInfo> {
  const auth = AuthStore.get("codex")
  if (!auth) throw new Error("codex: not logged in (run /login)")

  const expiresSoon = !auth.access || !auth.expires || auth.expires - Date.now() <= ACCESS_TOKEN_REFRESH_SKEW_MS
  if (!expiresSoon) return auth

  if (!refreshPromise) {
    const refreshToken = auth.refresh
    if (!refreshToken) throw new Error("codex: token expired and no refresh token; re-run /login")
    refreshPromise = refreshAccessToken(refreshToken)
      .then((tokens) => persist(tokens, refreshToken, auth.accountId))
      .finally(() => {
        refreshPromise = undefined
      })
  }
  return refreshPromise
}

/** Pull the text out of a Responses-API content value (string or block array). */
function responsesContentText(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === "object" && typeof (b as any).text === "string" ? (b as any).text : ""))
      .join("")
  }
  return ""
}

/** Adapt a standard Responses-API request body to what Codex's backend requires:
 *  (1) system/developer messages moved from `input` into top-level `instructions`
 *      (Codex rejects system messages), and (2) `store: false` (Codex won't persist). */
function codexResponsesBody(bodyStr: string): string {
  try {
    const body = JSON.parse(bodyStr)
    body.store = false // Codex: "Store must be set to false"
    // Responses API takes reasoning.effort, not a top-level reasoning_effort.
    if (body.reasoning_effort) {
      body.reasoning = { ...(body.reasoning || {}), effort: body.reasoning_effort }
      delete body.reasoning_effort
    }
    // Function tools: strict must be a boolean (LangChain emits null) — drop it.
    if (Array.isArray(body.tools)) {
      for (const t of body.tools) if (t && t.strict == null) delete t.strict
    }
    if (Array.isArray(body.input)) {
      const systemTexts: string[] = []
      body.input = body.input.filter((item: any) => {
        if (item?.role === "system" || item?.role === "developer") {
          const t = responsesContentText(item.content)
          if (t) systemTexts.push(t)
          return false
        }
        return true
      })
      if (systemTexts.length) {
        body.instructions = [body.instructions, ...systemTexts].filter(Boolean).join("\n\n")
      }
    }
    return JSON.stringify(body)
  } catch {
    return bodyStr
  }
}

/** Fetch that refreshes on demand, injects the bearer + ChatGPT-Account-Id, and
 *  routes chat/completions or responses requests to the Codex responses endpoint. */
async function injectingFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const auth = await validAuth()

  const headers = new Headers(input instanceof Request ? input.headers : undefined)
  if (init?.headers) {
    new Headers(init.headers as HeadersInit).forEach((value, key) => headers.set(key, value))
  }
  headers.set("authorization", `Bearer ${auth.access}`)
  headers.set("User-Agent", USER_AGENT)
  headers.set("originator", "multicode")
  if (auth.accountId) headers.set("ChatGPT-Account-Id", auth.accountId)

  const parsed =
    input instanceof URL ? input : new URL(typeof input === "string" ? input : (input as Request).url)
  const target =
    parsed.pathname.includes("/v1/responses") || parsed.pathname.includes("/chat/completions")
      ? new URL(CODEX_API_ENDPOINT)
      : parsed

  // Codex's responses backend rejects system messages in `input` ("System
  // messages are not allowed"); the Responses API wants the system prompt in
  // the top-level `instructions` field. Move any system/developer items there.
  if (typeof init?.body === "string" && target.pathname.endsWith("/responses")) {
    init = { ...init, body: codexResponsesBody(init.body) }
  }

  const res = await fetch(target, { ...init, headers })
  if (process.env.MC_DEBUG_CODEX && !res.ok) {
    const reqBody = typeof init?.body === "string" ? init.body.slice(0, 700) : "(non-string body)"
    const resBody = await res
      .clone()
      .text()
      .catch(() => "")
    console.error(`[codex-debug] ${res.status} ${target.href}\n  req: ${reqBody}\n  res: ${resBody.slice(0, 900)}`)
  }
  return res
}

// ---------- login flows ----------

// Device-code flow (headless): usercode + poll, then oauth/token exchange.
async function startDeviceLogin(): Promise<LoginInitiation> {
  const deviceResponse = await fetch(`${ISSUER}/api/accounts/deviceauth/usercode`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
    body: JSON.stringify({ client_id: CLIENT_ID }),
  })
  if (!deviceResponse.ok) throw new Error(`Codex device auth failed to initiate (${deviceResponse.status})`)

  const deviceData = (await deviceResponse.json()) as {
    device_auth_id: string
    user_code: string
    interval: string
  }
  const intervalMs = Math.max(parseInt(deviceData.interval) || 5, 1) * 1000

  void (async () => {
    try {
      while (true) {
        const response = await fetch(`${ISSUER}/api/accounts/deviceauth/token`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
          body: JSON.stringify({
            device_auth_id: deviceData.device_auth_id,
            user_code: deviceData.user_code,
          }),
        })
        if (response.ok) {
          const data = (await response.json()) as { authorization_code: string; code_verifier: string }
          const tokenResponse = await fetch(`${ISSUER}/oauth/token`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              grant_type: "authorization_code",
              code: data.authorization_code,
              redirect_uri: `${ISSUER}/deviceauth/callback`,
              client_id: CLIENT_ID,
              code_verifier: data.code_verifier,
            }).toString(),
          })
          if (!tokenResponse.ok) throw new Error(`Codex token exchange failed: ${tokenResponse.status}`)
          persist((await tokenResponse.json()) as TokenResponse)
          console.log("[codex] device login complete — token stored")
          return
        }
        // 403/404 = still pending; anything else is terminal.
        if (response.status !== 403 && response.status !== 404) {
          throw new Error(`Codex device auth returned ${response.status}`)
        }
        await sleep(intervalMs + OAUTH_POLLING_SAFETY_MARGIN_MS)
      }
    } catch (err) {
      console.error(`[codex] device login failed: ${(err as Error).message}`)
    }
  })()

  return {
    url: `${ISSUER}/codex/device`,
    userCode: deviceData.user_code,
    instructions: `Open ${ISSUER}/codex/device and enter code: ${deviceData.user_code}`,
  }
}

// Browser PKCE loopback flow.
let loopbackServer: ReturnType<typeof createServer> | undefined

async function startBrowserLogin(): Promise<LoginInitiation> {
  const pkce = await generatePKCE()
  const state = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)).buffer)

  if (loopbackServer) {
    loopbackServer.close()
    loopbackServer = undefined
  }

  await new Promise<void>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url || "/", `http://localhost:${OAUTH_PORT}`)
      if (url.pathname !== OAUTH_REDIRECT_PATH) {
        res.writeHead(404)
        res.end("Not found")
        return
      }
      const code = url.searchParams.get("code")
      const returnedState = url.searchParams.get("state")
      const error = url.searchParams.get("error")
      if (error || !code || returnedState !== state) {
        res.writeHead(400, { "Content-Type": "text/plain" })
        res.end("Authorization failed. You can close this window.")
        server.close()
        loopbackServer = undefined
        return
      }
      res.writeHead(200, { "Content-Type": "text/html" })
      res.end("<h1>Authorization successful</h1><p>You can close this window and return to MultiCode.</p>")
      exchangeCodeForTokens(code, pkce)
        .then((tokens) => {
          persist(tokens)
          console.log("[codex] browser login complete — token stored")
        })
        .catch((err) => console.error(`[codex] browser login failed: ${(err as Error).message}`))
        .finally(() => {
          server.close()
          loopbackServer = undefined
        })
    })
    server.once("error", (err) => {
      loopbackServer = undefined
      reject(err)
    })
    server.listen(OAUTH_PORT, () => {
      loopbackServer = server
      resolve()
    })
  })

  return {
    url: buildAuthorizeUrl(pkce, state),
    instructions: "Open this URL in your browser to authorize. This window will close automatically.",
  }
}

// ---------- ProviderDef ----------

export const codexProvider: ProviderDef = {
  id: "codex",
  label: "Codex · ChatGPT (Pro/Plus OAuth)",
  ready: () => {
    const auth = AuthStore.get("codex")
    return Boolean(auth && (auth.refresh || (auth.expires && auth.expires > Date.now())))
  },
  listModels: (): Promise<ModelInfo[]> => enrichModels(CODEX_MODELS, ["openai", "opencode"]),
  buildModel: (selection: ModelSelection): BaseChatModel =>
    new ChatOpenAI({
      model: selection.model || DEFAULT_MODEL,
      apiKey: "oauth",
      streaming: true,
      // Codex's backend speaks the OpenAI *Responses* API, so emit that body
      // shape (input/instructions), not chat-completions (messages).
      useResponsesApi: true,
      configuration: {
        // With useResponsesApi, ChatOpenAI POSTs to `${baseURL}/responses`,
        // i.e. the Codex responses endpoint. injectingFetch adds auth headers.
        baseURL: "https://chatgpt.com/backend-api/codex",
        fetch: injectingFetch as unknown as typeof fetch,
      },
      // Codex reasoning models take BOTH effort and a speed knob (standard/fast).
      ...chatOptionsFor(selection, { withSpeed: true }),
    }),
  login: async (method?: string) => {
    if (method === "browser") return startBrowserLogin()
    return startDeviceLogin()
  },
}
