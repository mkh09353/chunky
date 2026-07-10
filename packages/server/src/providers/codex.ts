// Codex / ChatGPT subscription provider, ported from opencode's
// packages/opencode/src/plugin/openai/codex.ts. WORKS end-to-end (chat,
// streaming, tools, effort) on a real ChatGPT sub.
//
// ChatGPT's Codex backend (https://chatgpt.com/backend-api/codex/responses)
// speaks the OpenAI *Responses* API. LangChain's ChatOpenAI handles that shape
// natively via `useResponsesApi: true` (body, streaming, tool round-trips) — so
// we do NOT hand-build responses bodies. `reasoningEffort` is set natively and
// `store:false` via modelKwargs. The only hand-handling (in injectingFetch →
// codexResponsesBody) is for Codex's *non-standard deviations* from the public
// Responses API, which no SDK knows about: it forbids system messages (moved to
// top-level `instructions`) and rejects LangChain's `strict:null` on tools.
// These are empirical (from the endpoint's 400 messages); set CHUNKY_DEBUG_CODEX=1
// to log the request/response if the private backend changes its rules.
import type { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { ChatOpenAI } from "@langchain/openai"
import { createServer } from "node:http"
import { AuthStore, type OAuthInfo } from "./auth-store.ts"
import type { LoginInitiation, ProviderDef } from "./registry.ts"
import { enrichModels, type ModelInfo } from "./models-catalog.ts"
import type { ModelSelection } from "../settings.ts"
import { CHUNKY_USER_AGENT } from "./app-info.ts"

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
const ISSUER = "https://auth.openai.com"
const CODEX_API_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses"
const OAUTH_PORT = 1455
const OAUTH_REDIRECT_PATH = "/auth/callback"
const REDIRECT_URI = `http://localhost:${OAUTH_PORT}${OAUTH_REDIRECT_PATH}`
const OAUTH_POLLING_SAFETY_MARGIN_MS = 3_000
const DEFAULT_MODEL = process.env.CODEX_MODEL || "gpt-5.5"

// Models a ChatGPT account can actually use via the Codex backend. This is
// opencode's ALLOWED_MODELS set (codex.ts) — the plain `-codex` variants
// (gpt-5.3-codex, gpt-5.2-codex, …) return "not supported when using Codex with
// a ChatGPT account", so they're deliberately excluded. Enriched from models.dev.
const CODEX_MODELS = ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex-spark"]
// Per-process session id sent on the `session-id` header (matches codex CLI).
const CODEX_SESSION_ID = crypto.randomUUID()

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
    originator: "chunky",
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

/** Adapt the Responses-API body for Codex's *non-standard* deviations that no
 *  SDK knows about: (1) move system/developer messages out of `input` into the
 *  top-level `instructions` (Codex forbids system messages — the public Responses
 *  API allows them), and (2) drop `strict:null` on function tools (a LangChain
 *  quirk the endpoint rejects). `store` and `reasoning.effort` are set natively
 *  on the model, so they're not touched here. */
function codexResponsesBody(bodyStr: string): string {
  try {
    const body = JSON.parse(bodyStr)
    // Codex CLI does not send max_output_tokens; the backend can reject it.
    delete body.max_output_tokens
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
  headers.set("User-Agent", CHUNKY_USER_AGENT)
  headers.set("originator", "chunky")
  headers.set("session-id", CODEX_SESSION_ID) // codex CLI sends one; helps attribution
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
  if (process.env.CHUNKY_DEBUG_CODEX && !res.ok) {
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
    headers: { "Content-Type": "application/json", "User-Agent": CHUNKY_USER_AGENT },
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
          headers: { "Content-Type": "application/json", "User-Agent": CHUNKY_USER_AGENT },
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
    kind: "url",
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
      res.end("<h1>Authorization successful</h1><p>You can close this window and return to Chunky.</p>")
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
    kind: "url",
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
      // shape (input/instructions), not chat-completions (messages). LangChain
      // handles the shape; we set store/effort the native way so it emits the
      // correct `store` and `reasoning.effort` fields (no body rewrite needed).
      useResponsesApi: true,
      // reasoningEffort is a native ChatOpenAI field → LangChain emits the
      // correct `reasoning.effort` on the Responses path.
      ...(selection.effort ? { reasoningEffort: selection.effort as any } : {}),
      configuration: {
        // With useResponsesApi, ChatOpenAI POSTs to `${baseURL}/responses`,
        // i.e. the Codex responses endpoint. injectingFetch adds auth headers.
        baseURL: "https://chatgpt.com/backend-api/codex",
        fetch: injectingFetch as unknown as typeof fetch,
      },
      // `store` isn't a ChatOpenAI constructor field, and Codex-only speed maps
      // to service_tier — both go through modelKwargs (spread into the body).
      modelKwargs: {
        store: false, // Codex requires store:false.
        // With store:false the endpoint is stateless, so a reasoning model needs
        // its encrypted reasoning returned to carry state across turns / tool
        // round-trips (opencode's transform.ts does the same).
        include: ["reasoning.encrypted_content"],
        ...(selection.speed === "fast" ? { service_tier: "priority" } : {}),
      },
    }),
  login: async (method?: string) => {
    if (method === "browser") return startBrowserLogin()
    return startDeviceLogin()
  },
}
