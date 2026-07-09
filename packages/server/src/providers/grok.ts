// Grok / xAI subscription provider (OpenAI-compatible), ported from opencode's
// packages/opencode/src/plugin/xai.ts.
//
// Two login flows both land the same {access,refresh,expires} in auth.json:
//   - device-code (RFC 8628): headless, prints a URL + short user_code. This is
//     the path we expose by default — it works over SSH/CI and is testable
//     against the live xAI endpoint without a loopback server.
//   - browser PKCE loopback: opens a 127.0.0.1:56121 callback server and returns
//     an authorize URL for the user to open.
//
// buildModel() returns a ChatOpenAI pointed at https://api.x.ai/v1 with a custom
// fetch that refreshes-on-demand (single-flight) and injects Authorization.
import type { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { ChatOpenAI } from "@langchain/openai"
import { createServer } from "node:http"
import { AuthStore, type OAuthInfo } from "./auth-store.ts"
import type { LoginInitiation, ProviderDef } from "./registry.ts"
import { enrichModels, type ModelInfo } from "./models-catalog.ts"
import { chatOptionsFor } from "./model-options.ts"
import type { ModelSelection } from "../settings.ts"

// Public Grok-CLI OAuth client. xAI's auth server rejects loopback OAuth from
// non-allowlisted clients, so we reuse the Grok-CLI client_id xAI ships for
// desktop OAuth flows (source: opencode xai.ts).
const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828"
const AUTHORIZE_URL = "https://auth.x.ai/oauth2/authorize"
const TOKEN_URL = "https://auth.x.ai/oauth2/token"
const DEVICE_AUTHORIZATION_URL = "https://auth.x.ai/oauth2/device/code"
const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code"
const SCOPE = "openid profile email offline_access grok-cli:access api:access"
const API_BASE = "https://api.x.ai/v1"
const DEFAULT_MODEL = process.env.GROK_MODEL || "grok-4"

// Curated Grok chat models offered in the picker (reasoning grok-4.x family).
// Enriched from models.dev's "xai" provider; unknown ids degrade gracefully.
const GROK_MODELS = ["grok-4.5", "grok-4.3", "grok-4"]

const DEVICE_CODE_DEFAULT_INTERVAL_MS = 5_000
const DEVICE_CODE_MIN_INTERVAL_MS = 1_000
const DEVICE_CODE_SLOW_DOWN_INCREMENT_MS = 5_000
const DEVICE_CODE_DEFAULT_EXPIRES_MS = 5 * 60 * 1000
const OAUTH_POLLING_SAFETY_MARGIN_MS = 3_000

// xAI's registered redirect for the Grok-CLI client is bound to this exact host:port.
const OAUTH_HOST = "127.0.0.1"
const OAUTH_PORT = 56121
const OAUTH_REDIRECT_PATH = "/callback"
const REDIRECT_URI = `http://${OAUTH_HOST}:${OAUTH_PORT}${OAUTH_REDIRECT_PATH}`

// Refresh a little before expiry so a long tool call doesn't hit a mid-flight 401.
const ACCESS_TOKEN_REFRESH_SKEW_MS = 120_000

const USER_AGENT = "multicode-cli/0.0.0"

interface PkceCodes {
  verifier: string
  challenge: string
}

interface TokenResponse {
  access_token: string
  refresh_token: string
  id_token?: string
  token_type?: string
  expires_in?: number
  scope?: string
}

function authHeaders() {
  return {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
    "User-Agent": USER_AGENT,
  }
}

// ---------- PKCE / crypto helpers ----------

function generateRandomString(length: number): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
  return Array.from(crypto.getRandomValues(new Uint8Array(length)))
    .map((b) => chars[b % chars.length])
    .join("")
}

function base64UrlEncode(buffer: ArrayBuffer): string {
  const binary = String.fromCharCode(...new Uint8Array(buffer))
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

async function generatePKCE(): Promise<PkceCodes> {
  const verifier = generateRandomString(64)
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
  return { verifier, challenge: base64UrlEncode(hash) }
}

function generateState(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)).buffer)
}

/** Unsigned JWT exp check — used only to decide whether to proactively refresh. */
function accessTokenIsExpiring(token: string | undefined, skewMs = ACCESS_TOKEN_REFRESH_SKEW_MS): boolean {
  if (!token || typeof token !== "string") return false
  const parts = token.split(".")
  if (parts.length < 2) return false
  try {
    let payload = parts[1].replace(/-/g, "+").replace(/_/g, "/")
    while (payload.length % 4 !== 0) payload += "="
    const claims = JSON.parse(Buffer.from(payload, "base64").toString("utf8"))
    if (typeof claims?.exp !== "number") return false
    return claims.exp * 1000 <= Date.now() + Math.max(0, skewMs)
  } catch {
    return false
  }
}

// ---------- token endpoint calls ----------

function buildAuthorizeUrl(pkce: PkceCodes, state: string, nonce: string): string {
  // plan=generic opts into xAI's generic OAuth plan tier (required for
  // non-allowlisted clients); referrer attributes the login in xAI's logs.
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    state,
    nonce,
    plan: "generic",
    referrer: "multicode",
  })
  return `${AUTHORIZE_URL}?${params.toString()}`
}

async function exchangeCodeForTokens(code: string, pkce: PkceCodes): Promise<TokenResponse> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: authHeaders(),
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: pkce.verifier,
    }).toString(),
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => "")
    throw new Error(`xAI token exchange failed (${response.status})${detail ? `: ${detail}` : ""}`)
  }
  return response.json() as Promise<TokenResponse>
}

async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: authHeaders(),
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }).toString(),
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => "")
    throw new Error(`xAI token refresh failed (${response.status})${detail ? `: ${detail}` : ""}`)
  }
  return response.json() as Promise<TokenResponse>
}

export interface DeviceCodeResponse {
  device_code: string
  user_code: string
  verification_uri: string
  verification_uri_complete?: string
  expires_in?: number
  interval?: number
}

async function requestDeviceCode(): Promise<DeviceCodeResponse> {
  const response = await fetch(DEVICE_AUTHORIZATION_URL, {
    method: "POST",
    headers: authHeaders(),
    body: new URLSearchParams({ client_id: CLIENT_ID, scope: SCOPE }).toString(),
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => "")
    throw new Error(`xAI device code request failed (${response.status})${detail ? `: ${detail}` : ""}`)
  }
  const json = (await response.json()) as DeviceCodeResponse
  if (!json.device_code || !json.user_code || !json.verification_uri) {
    throw new Error("xAI device code response is missing device_code / user_code / verification_uri")
  }
  return json
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function positiveSecondsToMs(value: unknown, defaultMs: number): number {
  const seconds = Number(value)
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : defaultMs
}

async function pollDeviceCodeToken(device: DeviceCodeResponse): Promise<TokenResponse> {
  const expiresInMs = positiveSecondsToMs(device.expires_in, DEVICE_CODE_DEFAULT_EXPIRES_MS)
  const deadline = Date.now() + expiresInMs
  let intervalMs = Math.max(
    positiveSecondsToMs(device.interval, DEVICE_CODE_DEFAULT_INTERVAL_MS),
    DEVICE_CODE_MIN_INTERVAL_MS,
  )

  while (Date.now() < deadline) {
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: authHeaders(),
      body: new URLSearchParams({
        grant_type: DEVICE_CODE_GRANT_TYPE,
        client_id: CLIENT_ID,
        device_code: device.device_code,
      }).toString(),
    })
    if (response.ok) return (await response.json()) as TokenResponse

    const body = (await response.json().catch(() => ({}))) as { error?: string; error_description?: string }
    const remaining = Math.max(0, deadline - Date.now())
    // RFC 8628 §3.5 backoff.
    if (body.error === "authorization_pending") {
      await sleep(Math.min(intervalMs + OAUTH_POLLING_SAFETY_MARGIN_MS, remaining))
      continue
    }
    if (body.error === "slow_down") {
      intervalMs += DEVICE_CODE_SLOW_DOWN_INCREMENT_MS
      await sleep(Math.min(intervalMs + OAUTH_POLLING_SAFETY_MARGIN_MS, remaining))
      continue
    }
    if (body.error === "access_denied" || body.error === "authorization_denied") {
      throw new Error("xAI device authorization was denied")
    }
    if (body.error === "expired_token") {
      throw new Error("xAI device code expired - please re-run login")
    }
    const detail = body.error_description ?? body.error ?? ""
    throw new Error(`xAI device token exchange failed (${response.status})${detail ? `: ${detail}` : ""}`)
  }
  throw new Error("xAI device authorization timed out")
}

// ---------- persistence helper ----------

function persist(tokens: TokenResponse, prevRefresh?: string): OAuthInfo {
  const info: OAuthInfo = {
    type: "oauth",
    access: tokens.access_token,
    refresh: tokens.refresh_token || prevRefresh || "",
    expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
  }
  AuthStore.set("grok", info)
  return info
}

// ---------- single-flight refreshing token getter ----------

let refreshPromise: Promise<OAuthInfo> | undefined

async function validAccessToken(): Promise<string> {
  const auth = AuthStore.get("grok")
  if (!auth) throw new Error("grok: not logged in (run /login)")

  const expiresSoon =
    !auth.expires ||
    auth.expires - Date.now() <= ACCESS_TOKEN_REFRESH_SKEW_MS ||
    accessTokenIsExpiring(auth.access)

  if (!expiresSoon) return auth.access

  if (!refreshPromise) {
    const refreshToken = auth.refresh
    if (!refreshToken) throw new Error("grok: token expired and no refresh token; re-run /login")
    // Collapse concurrent refreshes onto one HTTP call so the rotating
    // refresh_token isn't replayed by parallel in-flight requests.
    refreshPromise = refreshAccessToken(refreshToken)
      .then((tokens) => persist(tokens, refreshToken))
      .finally(() => {
        refreshPromise = undefined
      })
  }
  const refreshed = await refreshPromise
  return refreshed.access
}

/** Fetch that refreshes on demand and injects the xAI bearer token. */
async function injectingFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const token = await validAccessToken()
  const headers = new Headers(input instanceof Request ? input.headers : undefined)
  if (init?.headers) {
    new Headers(init.headers as HeadersInit).forEach((value, key) => headers.set(key, value))
  }
  headers.set("authorization", `Bearer ${token}`)
  headers.set("User-Agent", USER_AGENT)
  return fetch(input, { ...init, headers })
}

// ---------- login flows ----------

// Device-code flow: return the verification URL + user_code immediately and
// keep polling in the background; on success we persist to auth.json.
async function startDeviceLogin(): Promise<LoginInitiation> {
  const device = await requestDeviceCode()
  void pollDeviceCodeToken(device)
    .then((tokens) => {
      persist(tokens)
      console.log("[grok] device login complete — token stored")
    })
    .catch((err) => console.error(`[grok] device login failed: ${(err as Error).message}`))

  return {
    url: device.verification_uri_complete ?? device.verification_uri,
    userCode: device.user_code,
    instructions: `Open ${device.verification_uri} on any device and enter code: ${device.user_code}`,
  }
}

// Browser PKCE loopback flow: spin up the 127.0.0.1 callback server, return the
// authorize URL, and complete in the background when xAI redirects back.
let loopbackServer: ReturnType<typeof createServer> | undefined

async function startBrowserLogin(): Promise<LoginInitiation> {
  const pkce = await generatePKCE()
  const state = generateState()
  const nonce = generateState()

  if (loopbackServer) {
    loopbackServer.close()
    loopbackServer = undefined
  }

  await new Promise<void>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url || "/", `http://${OAUTH_HOST}:${OAUTH_PORT}`)
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
          console.log("[grok] browser login complete — token stored")
        })
        .catch((err) => console.error(`[grok] browser login failed: ${(err as Error).message}`))
        .finally(() => {
          server.close()
          loopbackServer = undefined
        })
    })
    server.once("error", (err) => {
      loopbackServer = undefined
      reject(err)
    })
    server.listen(OAUTH_PORT, OAUTH_HOST, () => {
      loopbackServer = server
      resolve()
    })
  })

  return {
    url: buildAuthorizeUrl(pkce, state, nonce),
    instructions: "Open this URL in your browser to authorize. This window will close automatically.",
  }
}

// ---------- ProviderDef ----------

export const grokProvider: ProviderDef = {
  id: "grok",
  label: "Grok · xAI (SuperGrok OAuth)",
  // Ready once we have a stored token that is either still valid or refreshable.
  ready: () => {
    const auth = AuthStore.get("grok")
    return Boolean(auth && (auth.refresh || (auth.expires && auth.expires > Date.now())))
  },
  listModels: (): Promise<ModelInfo[]> => enrichModels(GROK_MODELS, ["xai", "opencode"]),
  buildModel: (selection: ModelSelection): BaseChatModel =>
    new ChatOpenAI({
      model: selection.model || DEFAULT_MODEL,
      apiKey: "oauth", // dummy; the real token is injected by the fetch override
      streaming: true,
      configuration: {
        baseURL: API_BASE,
        fetch: injectingFetch as unknown as typeof fetch,
      },
      // Grok 4.x are reasoning models: apply the picker's effort (no speed knob).
      ...chatOptionsFor(selection),
    }),
  login: async (method?: string) => {
    if (method === "browser") return startBrowserLogin()
    return startDeviceLogin()
  },
}
