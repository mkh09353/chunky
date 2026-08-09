// Codex / ChatGPT subscription provider, ported from opencode's
// packages/opencode/src/plugin/openai/codex.ts. WORKS end-to-end (chat,
// streaming, tools, effort) on a real ChatGPT sub.
//
// ChatGPT's Codex backend (https://chatgpt.com/backend-api/codex/responses)
// speaks the OpenAI *Responses* API. LangChain's ChatOpenAI handles that shape
// natively via `useResponsesApi: true` (body, streaming, tool round-trips) — so
// we do NOT hand-build responses bodies. `reasoningEffort` is set natively and
// stateless reasoning via LangChain's `zdrEnabled` mode. The only hand-handling (in injectingFetch →
// codexResponsesBody) is for Codex's *non-standard deviations* from the public
// Responses API, which no SDK knows about: it forbids system messages (moved to
// top-level `instructions`) and rejects LangChain's `strict:null` on tools.
// These are empirical (from the endpoint's 400 messages); set CHUNKY_DEBUG_CODEX=1
// to log the request/response if the private backend changes its rules.
import type { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { ChatOpenAI } from "@langchain/openai"
import { createServer } from "node:http"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { AuthStore, type OAuthInfo } from "./auth-store.ts"
import type { LoginInitiation, ProviderDef } from "./registry.ts"
import { enrichModels, type ModelInfo } from "./models-catalog.ts"
import type { ModelSelection } from "../settings.ts"
import type { ProviderQuotaWindow } from "@chunky/protocol"
import type { CollectedProviderQuota } from "./quota-types.ts"
import { CHUNKY_USER_AGENT } from "./app-info.ts"
import { Store } from "../store.ts"

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
const ISSUER = "https://auth.openai.com"
export const CODEX_API_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses"
export const CODEX_USAGE_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage"
const CODEX_COMPATIBILITY_VERSION = "0.144.0"
const RESPONSES_LITE_MODEL = "gpt-5.6-luna"
const OAUTH_PORT = 1455
const OAUTH_REDIRECT_PATH = "/auth/callback"
const REDIRECT_URI = `http://localhost:${OAUTH_PORT}${OAUTH_REDIRECT_PATH}`
const OAUTH_POLLING_SAFETY_MARGIN_MS = 3_000
export const CODEX_DEFAULT_MODEL = process.env.CODEX_MODEL || "gpt-5.5"

// Models a ChatGPT account can actually use via the Codex backend. This is
// opencode's ALLOWED_MODELS set (codex.ts) — the plain `-codex` variants
// (gpt-5.3-codex, gpt-5.2-codex, …) return "not supported when using Codex with
// a ChatGPT account", so they're deliberately excluded. Enriched from models.dev.
const CODEX_MODELS = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex-spark"]
// Per-process session id sent on the `session-id` header (matches codex CLI).
const CODEX_SESSION_ID = crypto.randomUUID()
const LUNA_CODEX_SESSION_ID = Bun.randomUUIDv7()

export type CodexCompactionArtifact = { provider: string; model: string; replacementHistory: any[]; boundary: string }

/** Replace a known summarization boundary with a persisted native history. */
export function swapCodexCompactionHistory(bodyStr: string, artifact: CodexCompactionArtifact | null): string {
  if (!artifact) return bodyStr
  try {
    const body = JSON.parse(bodyStr) as any
    if (body.model !== artifact.model || !Array.isArray(body.input)) return bodyStr
    const matches = body.input.map((item: any, index: number) => ({ item, index })).filter(({ item }) => {
      const text = typeof item?.content === "string" ? item.content : Array.isArray(item?.content) ? item.content.map((x: any) => x?.text ?? "").join("") : ""
      return text.includes(artifact.boundary)
    })
    if (matches.length !== 1) return bodyStr
    const index = matches[0].index
    body.input = [...body.input.slice(0, index), ...artifact.replacementHistory, ...body.input.slice(index + 1)]
    return JSON.stringify(body)
  } catch { return bodyStr }
}

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

async function refreshAccessToken(refreshToken: string, signal?: AbortSignal): Promise<TokenResponse> {
  const response = await fetch(`${ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    signal,
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }).toString(),
  })
  if (!response.ok) throw new Error(`Codex token refresh failed: ${response.status}`)
  return response.json() as Promise<TokenResponse>
}

type CodexCliAuth = {
  tokens?: { id_token?: string; access_token?: string; refresh_token?: string; account_id?: string }
}
const failedCliAuthImports = new Set<string>()

function codexCliAuthPath(): string {
  const home = process.env.CODEX_HOME?.trim() || `${homedir()}/.codex`
  return `${home}/auth.json`
}

/** Whether there is a Codex CLI credential file worth attempting to import. */
export function hasCodexCliAuthFile(): boolean {
  return existsSync(codexCliAuthPath())
}

/** Import (read-only) the refresh token from a Codex CLI installation. */
export async function tryImportCodexCliAuth(): Promise<boolean> {
  const path = codexCliAuthPath()
  if (failedCliAuthImports.has(path)) return false
  try {
    if (!existsSync(path)) throw new Error("missing auth file")
    const parsed = JSON.parse(readFileSync(path, "utf8")) as CodexCliAuth
    const refresh = parsed.tokens?.refresh_token
    if (!refresh) throw new Error("missing refresh token")
    // Onboarding also uses this import path. Bound its network probe so a
    // stalled token endpoint cannot hold the first-run response indefinitely.
    const tokens = await refreshAccessToken(refresh, AbortSignal.timeout(10_000))
    persist(tokens, refresh, parsed.tokens?.account_id)
    return true
  } catch {
    failedCliAuthImports.add(path)
    return false
  }
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

export async function validAuth(): Promise<OAuthInfo> {
  const auth = AuthStore.get("codex")
  if (!auth) {
    if (await tryImportCodexCliAuth()) {
      const imported = AuthStore.get("codex")
      if (imported) return imported
    }
    throw new Error("codex: not logged in (run /login)")
  }

  const expiresSoon = !auth.access || !auth.expires || auth.expires - Date.now() <= ACCESS_TOKEN_REFRESH_SKEW_MS
  if (!expiresSoon) return auth

  if (!refreshPromise) {
    const refreshToken = auth.refresh
    if (!refreshToken) throw new Error("codex: token expired and no refresh token; re-run /login")
    refreshPromise = refreshAccessToken(refreshToken)
      .then((tokens) => persist(tokens, refreshToken, auth.accountId))
      .catch(async (error) => {
        if (await tryImportCodexCliAuth()) {
          const imported = AuthStore.get("codex")
          if (imported) return imported
        }
        throw error
      })
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
    // Let the model emit multiple tool calls per turn (LangChain omits the field).
    if (body.parallel_tool_calls === undefined) body.parallel_tool_calls = true
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

function stripImageDetail(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(stripImageDetail)
    return
  }
  if (!value || typeof value !== "object") return
  const record = value as Record<string, unknown>
  if (record.type === "input_image") delete record.detail
  Object.values(record).forEach(stripImageDetail)
}

/** Apply Codex's common Responses normalization, then opt Luna alone into the
 * Responses Lite wire contract. Sol, Terra, and legacy models remain unchanged. */
export function prepareCodexResponsesRequest(bodyStr: string, headers: Headers): string {
  const normalized = codexResponsesBody(bodyStr)
  let body: Record<string, any>
  try {
    body = JSON.parse(normalized) as Record<string, any>
  } catch {
    return normalized
  }
  if (body.model !== RESPONSES_LITE_MODEL) return normalized
  if (!Array.isArray(body.input)) throw new Error("Responses Lite requires an input array")
  if (body.tools !== undefined && !Array.isArray(body.tools)) {
    throw new Error("Responses Lite requires a tools array")
  }
  if (body.instructions !== undefined && typeof body.instructions !== "string") {
    throw new Error("Responses Lite requires string instructions")
  }

  stripImageDetail(body.input)
  body.input = [
    { type: "additional_tools", role: "developer", tools: body.tools ?? [] },
    ...(body.instructions
      ? [
          {
            type: "message",
            role: "developer",
            content: [{ type: "input_text", text: body.instructions }],
          },
        ]
      : []),
    ...body.input,
  ]
  delete body.tools
  delete body.instructions
  body.tool_choice = "auto"
  // The backend hard-requires this: "X-OpenAI-Internal-Codex-Responses-Lite
  // requires `parallel_tool_calls` to be false." (verified live 2026-07).
  body.parallel_tool_calls = false
  body.prompt_cache_key = LUNA_CODEX_SESSION_ID
  body.reasoning = {
    ...(body.reasoning && typeof body.reasoning === "object" ? body.reasoning : {}),
    context: "all_turns",
  }

  headers.set("session-id", LUNA_CODEX_SESSION_ID)
  headers.set("x-session-affinity", LUNA_CODEX_SESSION_ID)
  headers.set("version", CODEX_COMPATIBILITY_VERSION)
  headers.set("x-openai-internal-codex-responses-lite", "true")
  headers.delete("content-length")
  return JSON.stringify(body)
}

/** Fetch that refreshes on demand, injects the bearer + ChatGPT-Account-Id, and
 *  routes chat/completions or responses requests to the Codex responses endpoint. */
/** Build the common authenticated headers used by the Codex Responses fetch. */
export async function codexRequestHeaders(base?: Headers): Promise<Headers> {
  const auth = await validAuth()
  const headers = new Headers(base)
  headers.set("authorization", `Bearer ${auth.access}`)
  headers.set("User-Agent", CHUNKY_USER_AGENT)
  headers.set("originator", "chunky")
  headers.set("session-id", CODEX_SESSION_ID) // codex CLI sends one; helps attribution
  if (auth.accountId) headers.set("ChatGPT-Account-Id", auth.accountId)
  return headers
}

type CodexQuotaSnapshot = { fetchedAt: number; windows: ProviderQuotaWindow[] }
let passiveQuotaSnapshot: CodexQuotaSnapshot | undefined

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value)
  return undefined
}

function resetMillis(value: unknown): number | null {
  const numeric = finiteNumber(value)
  if (numeric !== undefined) return numeric < 10_000_000_000 ? numeric * 1000 : numeric
  if (typeof value !== "string") return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function codexWindow(value: unknown, kind: "five-hour" | "weekly" | "other", label: string, defaultMinutes?: number): ProviderQuotaWindow | undefined {
  if (!value || typeof value !== "object") return undefined
  const record = value as Record<string, unknown>
  const usedPercent = finiteNumber(record.used_percent ?? record.usedPercent ?? record.utilization)
  const seconds = finiteNumber(record.limit_window_seconds ?? record.limitWindowSeconds)
  const minutes = finiteNumber(record.window_minutes ?? record.windowMinutes) ?? (seconds === undefined ? defaultMinutes : seconds / 60)
  const resetAt = resetMillis(record.reset_at ?? record.resetAt)
  if (usedPercent === undefined && resetAt === null && minutes === undefined) return undefined
  return { kind, label, usedPercent: usedPercent ?? null, resetAt, ...(minutes === undefined ? {} : { windowMinutes: minutes }) }
}

/** Parse the account usage response without retaining or exposing its raw body. */
export function parseCodexUsage(body: unknown): ProviderQuotaWindow[] {
  if (!body || typeof body !== "object") return []
  const root = body as Record<string, any>
  const limits = root.rate_limit ?? root.rate_limits ?? root.rateLimit ?? root
  const primary = limits?.primary_window ?? limits?.primary ?? limits?.primaryWindow
  const secondary = limits?.secondary_window ?? limits?.secondary ?? limits?.secondaryWindow
  const primaryMinutes = primary && typeof primary === "object"
    ? finiteNumber(primary.window_minutes ?? primary.windowMinutes) ?? ((finiteNumber(primary.limit_window_seconds ?? primary.limitWindowSeconds) ?? 18_000) / 60)
    : 300
  const primaryKind = Math.abs(primaryMinutes - 300) <= 5
    ? "five-hour"
    : Math.abs(primaryMinutes - 7 * 24 * 60) <= 5 ? "weekly" : "other"
  return [
    codexWindow(primary, primaryKind, primaryKind === "five-hour" ? "5-hour" : primaryKind === "weekly" ? "Weekly" : "Primary", 300),
    codexWindow(secondary, "weekly", "Weekly", 7 * 24 * 60),
  ].filter((window): window is ProviderQuotaWindow => Boolean(window))
}

/** Parse rate-limit headers attached to ordinary Codex Responses calls. */
export function parseCodexQuotaHeaders(headers: Headers): ProviderQuotaWindow[] {
  const fromPrefix = (prefix: "primary" | "secondary", kind: "five-hour" | "weekly", label: string) => {
    const used = headers.get(`x-codex-${prefix}-used-percent`)
    const minutes = headers.get(`x-codex-${prefix}-window-minutes`)
    const reset = headers.get(`x-codex-${prefix}-reset-at`)
    if (used == null && minutes == null && reset == null) return undefined
    const parsedMinutes = finiteNumber(minutes)
    const validatedKind = prefix === "primary" && parsedMinutes !== undefined
      ? Math.abs(parsedMinutes - 300) <= 5 ? "five-hour" : Math.abs(parsedMinutes - 7 * 24 * 60) <= 5 ? "weekly" : "other"
      : kind
    const validatedLabel = validatedKind === "five-hour" ? "5-hour" : validatedKind === "weekly" ? "Weekly" : "Primary"
    return codexWindow({ used_percent: used, window_minutes: minutes, reset_at: reset }, validatedKind, validatedLabel)
  }
  return [
    fromPrefix("primary", "five-hour", "5-hour"),
    fromPrefix("secondary", "weekly", "Weekly"),
  ].filter((window): window is ProviderQuotaWindow => Boolean(window))
}

export function captureCodexQuotaHeaders(headers: Headers, now = Date.now()): void {
  const windows = parseCodexQuotaHeaders(headers)
  if (windows.length) passiveQuotaSnapshot = { fetchedAt: now, windows }
}

export function currentCodexPassiveQuota(): CodexQuotaSnapshot | undefined {
  return passiveQuotaSnapshot ? { fetchedAt: passiveQuotaSnapshot.fetchedAt, windows: passiveQuotaSnapshot.windows.map((window) => ({ ...window })) } : undefined
}

export function resetCodexQuotaForTests(): void { passiveQuotaSnapshot = undefined }

export async function fetchCodexQuota(dependencies: { fetch?: typeof fetch; now?: () => number } = {}): Promise<CollectedProviderQuota> {
  const headers = await codexRequestHeaders()
  const response = await (dependencies.fetch ?? fetch)(CODEX_USAGE_ENDPOINT, { method: "GET", headers })
  if (!response.ok) throw new Error(`Codex usage request failed (${response.status})`)
  const windows = parseCodexUsage(await response.json())
  if (!windows.length) throw new Error("Codex usage response did not contain quota windows")
  return { status: "available", source: "codex-usage", fetchedAt: (dependencies.now ?? Date.now)(), windows }
}

async function injectingFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const baseHeaders = new Headers(input instanceof Request ? input.headers : undefined)
  if (init?.headers) {
    new Headers(init.headers as HeadersInit).forEach((value, key) => baseHeaders.set(key, value))
  }
  // Authentication is applied after caller headers, preserving the provider's
  // original precedence for bearer/identity headers.
  const headers = await codexRequestHeaders(baseHeaders)

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
    let body = init.body
    const sessionId = (init as any).__chunkySessionId as string | undefined
    const artifact = sessionId ? Store.getCompactionArtifact(sessionId) : null
    if (artifact) body = swapCodexCompactionHistory(body, artifact as any)
    init = { ...init, body: prepareCodexResponsesRequest(body, headers) }
  }

  const res = await fetch(target, { ...init, headers })
  captureCodexQuotaHeaders(res.headers)
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
  billing: "subscription",
  ready: () => {
    const auth = AuthStore.get("codex")
    return Boolean(auth && (auth.refresh || (auth.expires && auth.expires > Date.now())))
  },
  listModels: (): Promise<ModelInfo[]> => enrichModels(CODEX_MODELS, ["openai", "opencode"]),
  // Preflight the OAuth token so a revoked/expired one throws here (→ clean
  // "run /login" error) instead of hanging inside the streaming request.
  ensureAuth: async (): Promise<void> => {
    await validAuth()
  },
  buildModel: (selection: ModelSelection, sessionId?: string): BaseChatModel => {
    const model = selection.model || CODEX_DEFAULT_MODEL
    // Luna's Responses Lite endpoint defaults to Codex Fast unless the user
    // explicitly selected a speed. Other Codex models keep their normal default.
    const speed = selection.speed ?? (model === RESPONSES_LITE_MODEL ? "fast" : undefined)
    return new ChatOpenAI({
      model,
      apiKey: "oauth",
      streaming: true,
      // Fail fast on auth errors instead of backing off through retries.
      maxRetries: 1,
      // Codex's backend speaks the OpenAI *Responses* API, so emit that body
      // shape (input/instructions), not chat-completions (messages). LangChain
      // handles the shape; we set store/effort the native way so it emits the
      // correct `store` and `reasoning.effort` fields (no body rewrite needed).
      useResponsesApi: true,
      // The Codex backend requires store:false. Use LangChain's ZDR switch rather
      // than only setting the wire field: it also prevents replaying ephemeral
      // response-item ids and carries encrypted reasoning when available.
      zdrEnabled: true,
      // reasoningEffort is a native ChatOpenAI field → LangChain emits the
      // correct `reasoning.effort` on the Responses path.
      ...(selection.effort ? { reasoningEffort: selection.effort as any } : {}),
      configuration: {
        // With useResponsesApi, ChatOpenAI POSTs to `${baseURL}/responses`,
        // i.e. the Codex responses endpoint. injectingFetch adds auth headers.
        baseURL: "https://chatgpt.com/backend-api/codex",
        fetch: ((input: RequestInfo | URL, init?: RequestInit) => injectingFetch(input, init && sessionId ? { ...init, __chunkySessionId: sessionId } as any : init)) as unknown as typeof fetch,
      },
      // Codex-only speed maps to service_tier through modelKwargs (spread into
      // the body). `zdrEnabled` above supplies store:false itself.
      modelKwargs: {
        // With store:false the endpoint is stateless, so a reasoning model needs
        // its encrypted reasoning returned to carry state across turns / tool
        // round-trips (opencode's transform.ts does the same).
        include: ["reasoning.encrypted_content"],
        ...(speed === "fast" ? { service_tier: "priority" } : {}),
      },
    })
  },
  login: async (method?: string) => {
    if (method === "browser") return startBrowserLogin()
    return startDeviceLogin()
  },
}
