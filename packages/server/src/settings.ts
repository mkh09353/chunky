// Persisted model-picker selection — survives a server restart.
//
// One JSON file (MC_SETTINGS || "settings.json", relative to the server cwd =
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

export interface Settings {
  /** Active provider id. */
  provider?: string
  /** provider id -> that provider's last selection. */
  selections?: Record<string, ModelSelection>
}

function settingsPath(): string {
  return process.env.MC_SETTINGS || "settings.json"
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
    console.warn(`[@mc/server] could not persist settings: ${(err as Error).message}`)
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
