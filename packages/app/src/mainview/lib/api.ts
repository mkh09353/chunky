import {
  ROUTES,
  readSSE,
  type AgentEvent,
  type CacheGuardResponse,
  type CacheStatusResponse,
  type CreateSessionResponse,
  type FileSearchItem,
  type FileSearchResponse,
  type GoalRequest,
  type GoalSnapshot,
  type GoalStateResponse,
  type ListSessionsResponse,
  type LoginInitiation,
  type ModesResponse,
  type Repo,
  type ReposResponse,
  type SendBlockedResponse,
  type SessionSummary,
} from "@chunky/protocol"

import { getRpc } from "./rpc"

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

// One pickable model in the composer's model menu — mirrors the server's
// ModelInfo plus which provider it belongs to and whether that provider is
// logged in (selecting a not-ready provider is allowed; it just won't run
// until /login).
export interface ModelRow {
  provider: string
  ready: boolean
  model: {
    id: string
    name: string
    reasoning: boolean
    contextLimit?: number
    custom?: boolean
    verified?: boolean
  }
}

const DEFAULT_CONFIG: AppConfig = {
  // Dev stack port (scripts/dev-server.ts). Only reached in the plain dev
  // browser when /chunky-config.json can't be fetched; inside electrobun the
  // bun process supplies the real URL over RPC.
  baseUrl: "http://localhost:4620",
  workspace: "",
  workspaceName: "chunky",
}

export async function loadConfig(): Promise<AppConfig> {
  // Inside electrobun, ask the bun process — it knows the real harness URL
  // (CHUNKY_URL / CHUNKY_PORT / dev default). The static chunky-config.json
  // fallback below can go stale: runtime rewrites of it land inside the .app
  // bundle where neither Vite HMR nor the views:// server ever reads them.
  try {
    const rpc = await getRpc()
    const fn = rpc?.request?.getConfig
    if (fn) {
      const data = (await fn()) as Partial<AppConfig> | null
      if (data?.baseUrl) {
        return {
          baseUrl: data.baseUrl,
          workspace: data.workspace || DEFAULT_CONFIG.workspace,
          workspaceName: data.workspaceName || DEFAULT_CONFIG.workspaceName,
        }
      }
    }
  } catch {
    /* fall through to the static file */
  }
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

export async function removeRepo(baseUrl: string, id: string): Promise<ReposResponse> {
  const res = await fetch(baseUrl + ROUTES.removeRepo(id), { method: "DELETE" })
  if (!res.ok) throw new Error(`remove repo failed (${res.status})`)
  return (await res.json()) as ReposResponse
}

/** Create a session pinned to `repoId`'s workspace (server default when omitted).
 *  Which repo is "current" is purely this client's UI state — the server no
 *  longer has a global active workspace. */
export async function createSession(baseUrl: string, repoId?: string | null): Promise<string> {
  const res = await fetch(baseUrl + ROUTES.createSession, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(repoId ? { repoId } : {}),
  })
  if (!res.ok) throw new Error(`create session failed (${res.status})`)
  const data = (await res.json()) as CreateSessionResponse
  return data.sessionId
}

/** A pasted image attached to a message (mirrors the TUI's ClipboardImage). */
export interface InputImage {
  base64: string
  mediaType: string
}

/** POST a user message. Returns null when accepted; on a cache-guard 409 the
 *  turn did NOT run — returns the block details so the caller can confirm and
 *  retry with `force: true`. */
export async function sendMessage(
  baseUrl: string,
  sessionId: string,
  text: string,
  opts: { force?: boolean; images?: InputImage[] } = {},
): Promise<SendBlockedResponse | null> {
  const res = await fetch(baseUrl + ROUTES.sendMessage(sessionId), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
      ...(opts.images?.length ? { images: opts.images } : {}),
      ...(opts.force ? { force: true } : {}),
    }),
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

// ---- Goal mode + shipit (slash commands) -----------------------------------

export async function fetchGoal(baseUrl: string, sessionId: string): Promise<GoalSnapshot | null> {
  const res = await fetch(baseUrl + ROUTES.goal(sessionId))
  if (!res.ok) throw new Error(`goal status failed (${res.status})`)
  const data = (await res.json()) as GoalStateResponse
  return data.goal
}

/** Set an objective (starts the autonomous loop; the server streams goal.update
 *  markers) or run a lifecycle action (pause/resume/clear). */
export async function postGoal(
  baseUrl: string,
  sessionId: string,
  req: GoalRequest,
): Promise<GoalSnapshot | null> {
  const res = await fetch(baseUrl + ROUTES.goal(sessionId), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  })
  const data = (await res.json().catch(() => ({}))) as GoalStateResponse & { error?: string }
  if (!res.ok || data.error) throw new Error(data.error || `goal request failed (${res.status})`)
  return data.goal
}

/** Ask THIS session to distill a handoff brief and ship it to a fresh
 *  workflows-mode goal session (via the ship_goal tool). 202 on dispatch; the
 *  brief-writing turn streams over the session's SSE like any other. */
export async function shipSession(baseUrl: string, sessionId: string, notes?: string): Promise<void> {
  const res = await fetch(baseUrl + ROUTES.ship(sessionId), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(notes ? { notes } : {}),
  })
  if (!res.ok && res.status !== 202) throw new Error(`shipit failed (${res.status})`)
}

/** FFF fuzzy file/dir search powering the composer's `@`-mention autocomplete,
 *  scoped to one repo's index (server default repo when omitted). Pass an
 *  AbortSignal so a superseded keystroke's request can be cancelled. */
export async function searchFiles(
  baseUrl: string,
  query: string,
  signal?: AbortSignal,
  limit = 12,
  repoId?: string | null,
): Promise<FileSearchItem[]> {
  const url = new URL(baseUrl + ROUTES.fileSearch)
  url.searchParams.set("q", query)
  url.searchParams.set("limit", String(limit))
  if (repoId) url.searchParams.set("repo", repoId)
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

/** Every provider's models flattened to picker rows (same source as the TUI's
 *  /model picker). A provider whose model list fails just contributes none. */
export async function listAllModels(baseUrl: string): Promise<ModelRow[]> {
  const res = await fetch(baseUrl + "/api/providers")
  if (!res.ok) throw new Error(`list providers failed (${res.status})`)
  const body = (await res.json()) as { providers?: Array<{ id: string; ready: boolean }> }
  const providers = body.providers ?? []
  const groups = await Promise.all(
    providers.map(async (p): Promise<ModelRow[]> => {
      try {
        const r = await fetch(baseUrl + `/api/providers/${p.id}/models`)
        if (!r.ok) return []
        const b = (await r.json()) as { models?: ModelRow["model"][] }
        return (b.models ?? []).map((model) => ({ provider: p.id, ready: p.ready, model }))
      } catch {
        return []
      }
    }),
  )
  return groups.flat()
}

/** Persist a model selection server-side (makes its provider active and
 *  invalidates the agent cache) and return the now-active selection. */
export async function selectModel(
  baseUrl: string,
  payload: { provider: string; model: string; effort?: string; speed?: string },
): Promise<ModelSelection> {
  const res = await fetch(baseUrl + "/api/model/select", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  })
  const data = (await res.json().catch(() => ({}))) as ModelSelection & { error?: string }
  if (!res.ok || data.error) throw new Error(data.error || `select model failed (${res.status})`)
  return data
}

// ---- Advisor (the always-on second-opinion model) ---------------------------

/** The advisor config + whether it's actually active (the server suppresses an
 *  advisor that equals the executor model). */
export interface AdvisorState {
  enabled: boolean
  provider?: string
  model?: string
  effort?: string
  active: boolean
}

export async function fetchAdvisor(baseUrl: string): Promise<AdvisorState | null> {
  try {
    const res = await fetch(baseUrl + "/api/advisor")
    if (!res.ok) return null
    const body = (await res.json()) as {
      config?: { enabled?: boolean; provider?: string; model?: string; effort?: string }
      active?: boolean
    }
    return {
      enabled: body.config?.enabled ?? false,
      provider: body.config?.provider,
      model: body.config?.model,
      effort: body.config?.effort,
      active: Boolean(body.active),
    }
  } catch {
    return null
  }
}

/** Merge-persist the advisor config (server invalidates the agent cache). */
export async function setAdvisor(
  baseUrl: string,
  patch: { enabled?: boolean; provider?: string; model?: string; effort?: string },
): Promise<AdvisorState> {
  const res = await fetch(baseUrl + "/api/advisor", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  })
  const body = (await res.json().catch(() => ({}))) as {
    config?: { enabled?: boolean; provider?: string; model?: string; effort?: string }
    active?: boolean
    error?: string
  }
  if (!res.ok || body.error) throw new Error(body.error || `set advisor failed (${res.status})`)
  return {
    enabled: body.config?.enabled ?? false,
    provider: body.config?.provider,
    model: body.config?.model,
    effort: body.config?.effort,
    active: Boolean(body.active),
  }
}

// ---- Providers + login -------------------------------------------------------

export interface ProviderRow {
  id: string
  label: string
  ready: boolean
  active: boolean
}

export async function listProviders(baseUrl: string): Promise<ProviderRow[]> {
  try {
    const res = await fetch(baseUrl + "/api/providers")
    if (!res.ok) return []
    const body = (await res.json()) as { providers?: ProviderRow[] }
    return body.providers ?? []
  } catch {
    return []
  }
}

/** Start a provider's browser-loopback login. The server's callback stores the
 *  token; poll `loginStatus` until ready. */
export async function initiateLogin(baseUrl: string, providerId: string): Promise<LoginInitiation> {
  const res = await fetch(baseUrl + `/api/auth/${providerId}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method: "browser" }),
  })
  const body = (await res.json()) as LoginInitiation | { error: string }
  if ("error" in body) throw new Error(body.error)
  return body
}

export async function loginStatus(baseUrl: string, providerId: string): Promise<boolean> {
  try {
    const res = await fetch(baseUrl + `/api/auth/${providerId}/status`)
    const body = (await res.json()) as { ready?: boolean }
    return Boolean(body.ready)
  } catch {
    return false
  }
}

// ---- Cache status + guard ----------------------------------------------------

/** Would a send on this thread right now rebuild a cold cache? Advisory only. */
export async function fetchCacheStatus(
  baseUrl: string,
  sessionId: string,
): Promise<CacheStatusResponse | null> {
  try {
    const res = await fetch(baseUrl + ROUTES.cacheStatus(sessionId))
    if (!res.ok) return null
    return (await res.json()) as CacheStatusResponse
  } catch {
    return null
  }
}

export async function fetchCacheGuard(baseUrl: string): Promise<CacheGuardResponse> {
  const res = await fetch(baseUrl + ROUTES.cacheGuard)
  if (!res.ok) throw new Error(`cache guard failed (${res.status})`)
  return (await res.json()) as CacheGuardResponse
}

export async function setCacheGuard(baseUrl: string, tokens: number | null): Promise<CacheGuardResponse> {
  const res = await fetch(baseUrl + ROUTES.cacheGuard, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tokens }),
  })
  if (!res.ok) throw new Error(`cache guard failed (${res.status})`)
  return (await res.json()) as CacheGuardResponse
}

// ---- Modes (named executor + advisor pairings) --------------------------------

export async function fetchModes(baseUrl: string): Promise<ModesResponse> {
  const res = await fetch(baseUrl + ROUTES.modes)
  if (!res.ok) throw new Error(`list modes failed (${res.status})`)
  return (await res.json()) as ModesResponse
}

/** Snapshot the CURRENT executor+advisor pairing under `name`. */
export async function saveMode(baseUrl: string, name: string): Promise<ModesResponse> {
  const res = await fetch(baseUrl + ROUTES.modes, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  })
  const body = (await res.json().catch(() => ({}))) as ModesResponse & { error?: string }
  if (!res.ok || body.error) throw new Error(body.error || `save mode failed (${res.status})`)
  return body
}

export interface AppliedMode {
  applied: string
  provider: string
  model: string | null
  effort?: string | null
  speed?: string | null
}

/** Apply a saved mode (model + advisor switch as one unit). */
export async function applyMode(baseUrl: string, name: string): Promise<AppliedMode> {
  const res = await fetch(baseUrl + ROUTES.applyMode(name), { method: "POST" })
  const body = (await res.json().catch(() => ({}))) as AppliedMode & { error?: string }
  if (!res.ok || body.error) throw new Error(body.error || `apply mode failed (${res.status})`)
  return body
}

export async function deleteMode(baseUrl: string, name: string): Promise<ModesResponse> {
  const res = await fetch(baseUrl + ROUTES.deleteMode(name), { method: "DELETE" })
  const body = (await res.json().catch(() => ({}))) as ModesResponse & { error?: string }
  if (!res.ok || body.error) throw new Error(body.error || `delete mode failed (${res.status})`)
  return body
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

const PROVIDER_MARKS: Record<string, string> = {
  anthropic: "A",
  codex: "C",
  grok: "G",
  zen: "Z",
}

/** Compact provider identity for dense model controls. */
export function providerMark(provider: string | null | undefined): string {
  if (!provider) return "?"
  return PROVIDER_MARKS[provider.toLowerCase()] ?? provider[0]!.toUpperCase()
}
