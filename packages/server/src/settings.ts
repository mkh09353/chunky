// Persisted model-picker selection — survives a server restart.
//
// One JSON file (CHUNKY_SETTINGS || "settings.json", relative to the server cwd =
// repo root). It records the active provider plus, per provider, the chosen
// model id and its reasoning options {effort, speed}. Keeping the selection
// per-provider means switching provider and back restores that provider's last
// model + knobs. Missing/corrupt file → defaults (never throws).
import { existsSync, readFileSync, writeFileSync } from "node:fs"

export type Effort = "low" | "medium" | "high" | "xhigh"
export type Speed = "standard" | "fast"

/** Per-provider selection: which model + reasoning knobs. */
export interface ModelSelection {
  model?: string
  effort?: Effort
  speed?: Speed
}

/** The always-on advisor: which stronger model the executor consults, and
 *  whether it's enabled. Absent provider/model => inactive until configured. */
export interface AdvisorConfig {
  enabled: boolean
  provider?: string
  model?: string
  effort?: Effort
}

export interface Settings {
  /** Active provider id. */
  provider?: string
  /** provider id -> that provider's last selection. */
  selections?: Record<string, ModelSelection>
  /** The advisor's model + on/off state. */
  advisor?: AdvisorConfig
  /** Cold-cache send guard threshold in tokens (see getCacheGuardTokens).
   *  Absent = default; null = guard off. */
  cacheGuardTokens?: number | null
}

function settingsPath(): string {
  return process.env.CHUNKY_SETTINGS || "settings.json"
}

let cache: Settings | undefined

export function loadSettings(): Settings {
  if (cache) return cache
  const p = settingsPath()
  if (!existsSync(p)) {
    cache = {}
    return cache
  }
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8"))
    cache = parsed && typeof parsed === "object" ? (parsed as Settings) : {}
  } catch {
    cache = {}
  }
  return cache
}

function save(next: Settings): void {
  cache = next
  try {
    writeFileSync(settingsPath(), JSON.stringify(next, null, 2))
  } catch (err) {
    console.warn(`[@chunky/server] could not persist settings: ${(err as Error).message}`)
  }
}

/** The active provider id from settings (undefined if never set). */
export function persistedProvider(): string | undefined {
  return loadSettings().provider
}

export function setPersistedProvider(id: string): void {
  const s = loadSettings()
  save({ ...s, provider: id })
}

/** The stored selection for a provider (empty object if none). */
export function selectionFor(id: string): ModelSelection {
  return loadSettings().selections?.[id] ?? {}
}

/** Merge-update a provider's selection (only defined fields overwrite). */
export function setSelectionFor(id: string, sel: ModelSelection): void {
  const s = loadSettings()
  const selections = { ...(s.selections ?? {}) }
  const prev = selections[id] ?? {}
  selections[id] = {
    ...prev,
    ...(sel.model !== undefined ? { model: sel.model } : {}),
    ...(sel.effort !== undefined ? { effort: sel.effort } : {}),
    ...(sel.speed !== undefined ? { speed: sel.speed } : {}),
  }
  save({ ...s, selections })
}

/** A send that would re-send at least this many tokens on a cold cache is
 *  refused until the user confirms. Configurable via /cacheguard in the TUI. */
export const DEFAULT_CACHE_GUARD_TOKENS = 100_000

/** The cache-guard threshold: tokens (>0), or null when the guard is off.
 *  Never-set falls back to DEFAULT_CACHE_GUARD_TOKENS. */
export function getCacheGuardTokens(): number | null {
  const v = loadSettings().cacheGuardTokens
  if (v === undefined) return DEFAULT_CACHE_GUARD_TOKENS
  return typeof v === "number" && v > 0 ? Math.floor(v) : null
}

/** Persist the cache-guard threshold (null or <=0 disables the guard). */
export function setCacheGuardTokens(tokens: number | null): number | null {
  const s = loadSettings()
  save({ ...s, cacheGuardTokens: typeof tokens === "number" && tokens > 0 ? Math.floor(tokens) : null })
  return getCacheGuardTokens()
}

/** The advisor config (default `{ enabled: true }` when never set — enabled but
 *  inactive until a provider/model is configured). */
export function getAdvisor(): AdvisorConfig {
  return loadSettings().advisor ?? { enabled: true }
}

/** Merge-update the advisor config (only defined fields overwrite) and persist. */
export function setAdvisor(patch: Partial<AdvisorConfig>): AdvisorConfig {
  const s = loadSettings()
  const prev = s.advisor ?? { enabled: true }
  const next: AdvisorConfig = {
    ...prev,
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    ...(patch.provider !== undefined ? { provider: patch.provider } : {}),
    ...(patch.model !== undefined ? { model: patch.model } : {}),
    ...(patch.effort !== undefined ? { effort: patch.effort } : {}),
  }
  save({ ...s, advisor: next })
  return next
}
