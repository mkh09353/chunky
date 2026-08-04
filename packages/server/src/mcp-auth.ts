import { createServer, type Server } from "node:http"
import { createHash, randomBytes } from "node:crypto"
import { AuthStore, type OAuthInfo } from "./providers/auth-store.ts"
import { loadSettings, type McpServerConfig } from "./settings.ts"

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
const TOKEN_URL = "https://oauth2.googleapis.com/token"
const DEFAULT_PORT = 56123
const DEFAULT_SCOPES = ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.compose"]
let callbackServer: Server | undefined
const b64 = (v: Uint8Array) => Buffer.from(v).toString("base64url")
const config = (id: string): McpServerConfig | undefined => loadSettings().mcpServers?.[id]
export const mcpConfig = config
export const mcpAuthKey = (id: string) => `mcp-${id}`
export const isMcpAuthorized = (id: string) => Boolean(AuthStore.get(mcpAuthKey(id)))
const verifier = () => b64(randomBytes(32))
const challenge = (v: string) => b64(createHash("sha256").update(v).digest())

export async function getFreshAccessToken(id: string, fetchImpl: (input: URL | RequestInfo, init?: RequestInit) => Promise<Response> = fetch as any): Promise<string> {
  const cfg = config(id), info = AuthStore.get(mcpAuthKey(id))
  if (!cfg) throw new Error(`MCP server "${id}" is not configured`)
  if (!info) throw new Error(`MCP server "${id}" needs authorization`)
  if (info.expires > Date.now() + 60_000) return info.access
  const response = await fetchImpl(TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: cfg.oauth.clientId, client_secret: cfg.oauth.clientSecret, grant_type: "refresh_token", refresh_token: info.refresh }) })
  if (!response.ok) throw new Error(`Google token refresh returned ${response.status}`)
  const body = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number }
  if (!body.access_token) throw new Error("Google token refresh did not return an access token")
  const next: OAuthInfo = { type: "oauth", access: body.access_token, refresh: body.refresh_token || info.refresh, expires: Date.now() + (body.expires_in ?? 3600) * 1000 }
  AuthStore.set(mcpAuthKey(id), next)
  return next.access
}

export async function startMcpAuthorization(id: string): Promise<{ kind: "url"; url: string; instructions: string }> {
  const cfg = config(id); if (!cfg) throw new Error(`MCP server "${id}" is not configured`)
  callbackServer?.close(); const port = cfg.oauth.callbackPort ?? DEFAULT_PORT, state = b64(randomBytes(24)), cv = verifier()
  const redirect = `http://localhost:${port}/callback`
  const server = createServer((req, res) => {
    const u = new URL(req.url || "/", redirect); if (u.pathname !== "/callback") { res.writeHead(404); res.end(); return }
    const code = u.searchParams.get("code"), returned = u.searchParams.get("state")
    if (!code || returned !== state) { res.writeHead(400); res.end("Authorization failed."); return }
    res.writeHead(200, { "content-type": "text/html" }); res.end("<h1>Authorization successful</h1><p>You can close this window.</p>")
    void fetch(TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code, client_id: cfg.oauth.clientId, client_secret: cfg.oauth.clientSecret, redirect_uri: redirect, grant_type: "authorization_code", code_verifier: cv }) }).then(async r => { if (!r.ok) throw new Error(`Google token exchange returned ${r.status}`); const b = await r.json() as { access_token?: string; refresh_token?: string; expires_in?: number }; if (!b.access_token || !b.refresh_token) throw new Error("Google authorization did not return required tokens"); AuthStore.set(mcpAuthKey(id), { type: "oauth", access: b.access_token, refresh: b.refresh_token, expires: Date.now() + (b.expires_in ?? 3600) * 1000 }) }).catch(e => console.error(`[mcp:${id}] authorization failed: ${(e as Error).message}`)).finally(() => { server.close(); callbackServer = undefined })
  })
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve) }); callbackServer = server
  const params = new URLSearchParams({ client_id: cfg.oauth.clientId, redirect_uri: redirect, response_type: "code", scope: (cfg.oauth.scopes?.length ? cfg.oauth.scopes : DEFAULT_SCOPES).join(" "), access_type: "offline", prompt: "consent", state, code_challenge: challenge(cv), code_challenge_method: "S256" })
  return { kind: "url", url: `${AUTH_URL}?${params}`, instructions: `Open the URL to authorize ${id}; return to Chunky when complete.` }
}
