// Flat token store, ported from opencode's auth/index.ts shape.
//
// One JSON file, keyed by provider id, mode 0600. Each entry is an OAuth record
// { type:"oauth", access, refresh, expires, accountId? } — the exact shape
// opencode persists so the login flows here can round-trip identically.
//
// Path: process.env.CHUNKY_AUTH || "auth.json" (relative to the server cwd = repo root).
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

export interface OAuthInfo {
  type: "oauth"
  access: string
  refresh: string
  /** Unix ms at which `access` expires (best-effort; xAI doesn't always return expires_in). */
  expires: number
  /** ChatGPT account id extracted from the id_token/access JWT (Codex only). */
  accountId?: string
}
export interface ApiInfo {
  type: "api"
  key: string
}

export type AuthInfo = OAuthInfo | ApiInfo

function authPath(): string {
  return process.env.CHUNKY_AUTH || "auth.json"
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
  // Atomic replacement prevents a reader from seeing a truncated shared auth file.
  // Callers read the entire store before changing one provider, preserving others.
  mkdirSync(dirname(p), { recursive: true })
  const temp = `${p}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(data, null, 2), { mode: 0o600 })
  renameSync(temp, p)
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
  getApiKey(provider: string): string | undefined {
    const info = readAll()[provider]
    return info && info.type === "api" && info.key ? info.key : undefined
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
