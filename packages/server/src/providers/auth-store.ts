// Flat token store, ported from opencode's auth/index.ts shape.
//
// One JSON file, keyed by provider id, mode 0600. Each entry is an OAuth record
// { type:"oauth", access, refresh, expires, accountId? } — the exact shape
// opencode persists so the login flows here can round-trip identically.
//
// Path: process.env.MC_AUTH || "auth.json" (relative to the server cwd = repo root).
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs"

export interface OAuthInfo {
  type: "oauth"
  access: string
  refresh: string
  /** Unix ms at which `access` expires (best-effort; xAI doesn't always return expires_in). */
  expires: number
  /** ChatGPT account id extracted from the id_token/access JWT (Codex only). */
  accountId?: string
}

export type AuthInfo = OAuthInfo

function authPath(): string {
  return process.env.MC_AUTH || "auth.json"
}

/** Read the whole store. Missing/corrupt file → empty object (never throws). */
export function readAll(): Record<string, AuthInfo> {
  const p = authPath()
  if (!existsSync(p)) return {}
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8"))
    return parsed && typeof parsed === "object" ? (parsed as Record<string, AuthInfo>) : {}
  } catch {
    return {}
  }
}

function writeAll(data: Record<string, AuthInfo>): void {
  const p = authPath()
  // Write then chmod: writeFileSync's `mode` only applies on create, so we
  // chmod unconditionally to guarantee 0600 even when the file already existed.
  writeFileSync(p, JSON.stringify(data, null, 2), { mode: 0o600 })
  try {
    chmodSync(p, 0o600)
  } catch {
    // best-effort on platforms without POSIX modes
  }
}

export const AuthStore = {
  get(provider: string): OAuthInfo | undefined {
    const info = readAll()[provider]
    return info && info.type === "oauth" ? info : undefined
  },
  set(provider: string, info: AuthInfo): void {
    const data = readAll()
    data[provider] = info
    writeAll(data)
  },
  remove(provider: string): void {
    const data = readAll()
    delete data[provider]
    writeAll(data)
  },
  all(): Record<string, AuthInfo> {
    return readAll()
  },
}
