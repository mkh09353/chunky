import {
  ROUTES,
  readSSE,
  type AgentEvent,
  type CreateSessionResponse,
  type FileSearchItem,
  type FileSearchResponse,
  type ListSessionsResponse,
  type Repo,
  type ReposResponse,
  type SendBlockedResponse,
  type SessionSummary,
} from "@chunky/protocol"

export type { SendBlockedResponse } from "@chunky/protocol"

export type { Repo } from "@chunky/protocol"

export type { FileSearchItem } from "@chunky/protocol"

export interface AppConfig {
  baseUrl: string
  workspace: string
  workspaceName: string
}

export interface ModelSelection {
  provider: string
  model: string | null
  effort?: string | null
  speed?: string | null
}

const DEFAULT_CONFIG: AppConfig = {
  baseUrl: "http://localhost:4599",
  workspace: "",
  workspaceName: "chunky",
}

export async function loadConfig(): Promise<AppConfig> {
  try {
    const res = await fetch("/chunky-config.json", { cache: "no-store" })
    if (res.ok) {
      const data = (await res.json()) as Partial<AppConfig>
      return {
        baseUrl: data.baseUrl || DEFAULT_CONFIG.baseUrl,
        workspace: data.workspace || DEFAULT_CONFIG.workspace,
        workspaceName: data.workspaceName || DEFAULT_CONFIG.workspaceName,
      }
    }
  } catch {
    /* fall through */
  }
  return DEFAULT_CONFIG
}

export async function listSessions(
  baseUrl: string,
  repoId?: string | null,
): Promise<SessionSummary[]> {
  const url = new URL(baseUrl + ROUTES.listSessions)
  if (repoId) url.searchParams.set("repo", repoId)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`list sessions failed (${res.status})`)
  const data = (await res.json()) as ListSessionsResponse
  const sessions = data.sessions ?? []
  // Most recent first for the side nav / resume picker.
  return sessions.slice().sort((a, b) => b.lastActivity - a.lastActivity)
}

// ---- Repos (workspaces) ---------------------------------------------------

export async function listRepos(baseUrl: string): Promise<ReposResponse> {
  const res = await fetch(baseUrl + ROUTES.repos)
  if (!res.ok) throw new Error(`list repos failed (${res.status})`)
  return (await res.json()) as ReposResponse
}

/** Add a folder as a repo and make it active. */
export async function addRepo(baseUrl: string, path: string): Promise<ReposResponse> {
  const res = await fetch(baseUrl + ROUTES.repos, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  })
  const data = (await res.json().catch(() => ({}))) as ReposResponse & { error?: string }
  if (!res.ok) throw new Error(data.error || `add repo failed (${res.status})`)
  return data
}

export async function selectRepo(baseUrl: string, id: string): Promise<ReposResponse> {
  const res = await fetch(baseUrl + ROUTES.selectRepo(id), { method: "POST" })
  if (!res.ok) throw new Error(`select repo failed (${res.status})`)
  return (await res.json()) as ReposResponse
}

export async function removeRepo(baseUrl: string, id: string): Promise<ReposResponse> {
  const res = await fetch(baseUrl + ROUTES.removeRepo(id), { method: "DELETE" })
  if (!res.ok) throw new Error(`remove repo failed (${res.status})`)
  return (await res.json()) as ReposResponse
}

export async function createSession(baseUrl: string): Promise<string> {
  const res = await fetch(baseUrl + ROUTES.createSession, { method: "POST" })
  if (!res.ok) throw new Error(`create session failed (${res.status})`)
  const data = (await res.json()) as CreateSessionResponse
  return data.sessionId
}

/** POST a user message. Returns null when accepted; on a cache-guard 409 the
 *  turn did NOT run — returns the block details so the caller can confirm and
 *  retry with `force: true`. */
export async function sendMessage(
  baseUrl: string,
  sessionId: string,
  text: string,
  force = false,
): Promise<SendBlockedResponse | null> {
  const res = await fetch(baseUrl + ROUTES.sendMessage(sessionId), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(force ? { text, force: true } : { text }),
  })
  if (res.status === 409) {
    return (await res.json()) as SendBlockedResponse
  }
  if (!res.ok && res.status !== 202) {
    throw new Error(`send message failed (${res.status})`)
  }
  return null
}

export async function interruptSession(baseUrl: string, sessionId: string): Promise<void> {
  await fetch(baseUrl + ROUTES.interrupt(sessionId), { method: "POST" }).catch(() => {})
}

/** FFF fuzzy file/dir search powering the composer's `@`-mention autocomplete.
 *  Pass an AbortSignal so a superseded keystroke's request can be cancelled. */
export async function searchFiles(
  baseUrl: string,
  query: string,
  signal?: AbortSignal,
  limit = 12,
): Promise<FileSearchItem[]> {
  const url = new URL(baseUrl + ROUTES.fileSearch)
  url.searchParams.set("q", query)
  url.searchParams.set("limit", String(limit))
  const res = await fetch(url, { signal })
  if (!res.ok) throw new Error(`file search failed (${res.status})`)
  const data = (await res.json()) as FileSearchResponse
  return data.items ?? []
}

export async function openEventStream(
  baseUrl: string,
  sessionId: string,
  onEvent: (ev: AgentEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(baseUrl + ROUTES.events(sessionId), { signal })
  if (!res.ok) throw new Error(`events stream failed (${res.status})`)
  for await (const ev of readSSE(res)) {
    if (signal?.aborted) break
    onEvent(ev)
  }
}

export async function fetchModel(baseUrl: string): Promise<ModelSelection | null> {
  try {
    const res = await fetch(baseUrl + "/api/model")
    if (!res.ok) return null
    return (await res.json()) as ModelSelection
  } catch {
    return null
  }
}

export function prettyModel(id: string | null | undefined): string {
  if (!id) return "…"
  const ACRONYMS = new Set(["glm", "gpt", "api", "llm"])
  return id
    .replace(/\[.*?\]/g, "")
    .split(/[-_]/)
    .filter(Boolean)
    .map((p) =>
      ACRONYMS.has(p.toLowerCase())
        ? p.toUpperCase()
        : /^[\d.]+$/.test(p)
          ? p
          : p[0]!.toUpperCase() + p.slice(1),
    )
    .join(" ")
}
