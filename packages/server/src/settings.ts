// Persisted model-picker selection — survives a server restart.
//
// One JSON file (CHUNKY_SETTINGS || "settings.json", relative to the server cwd =
// repo root). It records the active provider plus, per provider, the chosen
// model id and its reasoning options {effort, speed}. Keeping the selection
// per-provider means switching provider and back restores that provider's last
// model + knobs. Missing/corrupt file → defaults (never throws).
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { randomBytes } from "node:crypto"
import { join } from "node:path"

export type Effort = "low" | "medium" | "high" | "xhigh" | "max"
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

/** A named executor+advisor pairing (see /mode). The advisor is part of the
 *  mode on purpose: which advisor works depends on the executor (e.g. a Fable
 *  executor should NOT pair with a Fable advisor — advisorFor suppresses
 *  same-model pairs — so the Fable mode names a different advisor). */
export interface ModeSpec {
  provider: string
  model: string
  effort?: Effort
  speed?: Speed
  /** The paired advisor; null = advisor off in this mode. */
  advisor?: { provider: string; model: string; effort?: Effort } | null
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
  /** Named executor+advisor pairings, applied as one unit via /mode. */
  modes?: Record<string, ModeSpec>
  /** Global provider catalog overlays. Added ids supplement provider discovery;
   *  hidden ids disappear from pickers without invalidating existing sessions. */
  modelCatalog?: Record<string, ModelCatalogOverlay>
  /** Bearer token required from non-loopback HTTP clients (see index.ts).
   *  Generated on first use; settings.json is gitignored, so it stays local. */
  serverToken?: string
  /** Managed skill git repositories (cloned under stateDir/skill-repos/). */
  skillRepos?: SkillRepoRecord[]
}

/** A user-registered git remote that supplies Agent Skills (SKILL.md packages). */
export interface SkillRepoRecord {
  /** Filesystem-safe id (also the clone directory name). */
  id: string
  /** Git remote URL (https / git@ / ssh://git@). */
  url: string
  /** Optional branch pin; omit = remote default. */
  branch?: string
  /** Optional path inside the clone containing the skill collection. */
  subdir?: string
  /** Skill names explicitly disabled by the user. Kept per repository. */
  disabledSkills?: string[]
  /** When the repo was first added. */
  addedAt: number
  /** Last successful sync (clone or pull). */
  lastSync?: number
  /** Last sync error message, if any. */
  lastError?: string
}

export interface CatalogModelRecord {
  verified: boolean
  addedAt: number
}

export interface ModelCatalogOverlay {
  added?: Record<string, CatalogModelRecord>
  hidden?: string[]
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

export function modelCatalogFor(provider: string): ModelCatalogOverlay {
  const overlay = loadSettings().modelCatalog?.[provider]
  return {
    added: { ...(overlay?.added ?? {}) },
    hidden: [...(overlay?.hidden ?? [])],
  }
}

function saveModelCatalog(provider: string, overlay: ModelCatalogOverlay): void {
  const s = loadSettings()
  save({ ...s, modelCatalog: { ...(s.modelCatalog ?? {}), [provider]: overlay } })
}

/** Add a custom id, or restore it when it was hidden. */
export function addCatalogModel(provider: string, model: string, verified = false): ModelCatalogOverlay {
  const overlay = modelCatalogFor(provider)
  const added = { ...(overlay.added ?? {}) }
  added[model] = added[model] ?? { verified, addedAt: Date.now() }
  if (verified && !added[model]!.verified) added[model] = { ...added[model]!, verified: true }
  const next = { added, hidden: (overlay.hidden ?? []).filter((id) => id !== model) }
  saveModelCatalog(provider, next)
  return next
}

/** Hide an id from future picker listings. Existing selections remain valid. */
export function hideCatalogModel(provider: string, model: string): ModelCatalogOverlay {
  const overlay = modelCatalogFor(provider)
  const hidden = [...new Set([...(overlay.hidden ?? []), model])]
  const next = { ...overlay, hidden }
  saveModelCatalog(provider, next)
  return next
}

/** Make a hidden built-in, discovered, or custom id visible again. */
export function restoreCatalogModel(provider: string, model: string): ModelCatalogOverlay {
  const overlay = modelCatalogFor(provider)
  const next = { ...overlay, hidden: (overlay.hidden ?? []).filter((id) => id !== model) }
  saveModelCatalog(provider, next)
  return next
}

/** Replace availability for a complete snapshot of known models in one write.
 * Added/custom metadata is deliberately preserved. Models discovered after this
 * call are not hidden, so they retain the catalog's default-available behavior. */
export function setAvailableCatalogModels(
  provider: string,
  available: string[],
  allKnown: string[],
): ModelCatalogOverlay {
  const overlay = modelCatalogFor(provider)
  const visible = new Set(available)
  const hidden = [...new Set(allKnown)].filter((id) => !visible.has(id))
  const next = { ...overlay, hidden }
  saveModelCatalog(provider, next)
  return next
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

// ---- Server token: bearer auth for non-loopback clients ----

/** The token non-loopback HTTP requests must present as `Authorization: Bearer
 *  <token>` (index.ts enforces this). Generated once — 32 random bytes, hex —
 *  and persisted so it survives restarts. Loopback clients never need it, so
 *  the TUI/app keep working with zero setup. */
export function getServerToken(): string {
  const s = loadSettings()
  if (typeof s.serverToken === "string" && s.serverToken.length > 0) return s.serverToken
  const token = randomBytes(32).toString("hex")
  save({ ...s, serverToken: token })
  return token
}

// ---- Modes: named executor+advisor pairings ----

/** All saved modes, sorted by name. */
export function listModes(): Array<{ name: string } & ModeSpec> {
  const modes = loadSettings().modes ?? {}
  return Object.keys(modes)
    .sort()
    .map((name) => ({ name, ...modes[name]! }))
}

export function getMode(name: string): ModeSpec | undefined {
  return loadSettings().modes?.[name]
}

export function saveMode(name: string, spec: ModeSpec): void {
  const s = loadSettings()
  save({ ...s, modes: { ...(s.modes ?? {}), [name]: spec } })
}

/** Delete a mode; returns whether it existed. */
export function deleteMode(name: string): boolean {
  const s = loadSettings()
  if (!s.modes?.[name]) return false
  const modes = { ...s.modes }
  delete modes[name]
  save({ ...s, modes })
  return true
}

/** The CURRENT pairing as a ModeSpec — what "/mode save <name>" would snapshot:
 *  the active provider's selection plus the advisor (null when off/unconfigured). */
export function currentModeSpec(): ModeSpec {
  const s = loadSettings()
  const provider = s.provider ?? ""
  const sel = s.selections?.[provider] ?? {}
  const adv = getAdvisor()
  return {
    provider,
    model: sel.model ?? "",
    ...(sel.effort ? { effort: sel.effort } : {}),
    ...(sel.speed ? { speed: sel.speed } : {}),
    advisor:
      adv.enabled && adv.provider && adv.model
        ? { provider: adv.provider, model: adv.model, ...(adv.effort ? { effort: adv.effort } : {}) }
        : null,
  }
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

// ---- Managed skill repositories ----

/** Absolute root for skill-repo clones, next to settings.json. */
export function skillReposRoot(stateDir: string): string {
  return join(stateDir, "skill-repos")
}

/** All registered skill repos, sorted by id. */
export function listSkillRepos(): SkillRepoRecord[] {
  const repos = loadSettings().skillRepos ?? []
  return [...repos].sort((a, b) => a.id.localeCompare(b.id))
}

export function skillRepoById(id: string): SkillRepoRecord | undefined {
  return (loadSettings().skillRepos ?? []).find((r) => r.id === id)
}

/** Register a skill repo (caller clones first). Throws if id already exists. */
export function addSkillRepo(record: SkillRepoRecord): SkillRepoRecord {
  const s = loadSettings()
  const repos = [...(s.skillRepos ?? [])]
  if (repos.some((r) => r.id === record.id)) {
    throw new Error(`skill repo "${record.id}" already exists`)
  }
  repos.push(record)
  save({ ...s, skillRepos: repos })
  return record
}

/** Remove a skill repo registration. Returns whether it existed. */
export function removeSkillRepo(id: string): boolean {
  const s = loadSettings()
  const repos = s.skillRepos ?? []
  if (!repos.some((r) => r.id === id)) return false
  save({ ...s, skillRepos: repos.filter((r) => r.id !== id) })
  return true
}

/** Merge-update a skill repo record. Pass `lastError: undefined` to clear it.
 *  Returns the updated record or undefined if id is unknown. */
export function updateSkillRepo(
  id: string,
  patch: Partial<Pick<SkillRepoRecord, "branch" | "subdir" | "disabledSkills" | "lastSync" | "lastError">>,
): SkillRepoRecord | undefined {
  const s = loadSettings()
  const repos = [...(s.skillRepos ?? [])]
  const idx = repos.findIndex((r) => r.id === id)
  if (idx < 0) return undefined
  const prev = repos[idx]!
  const next: SkillRepoRecord = {
    id: prev.id,
    url: prev.url,
    addedAt: prev.addedAt,
  }
  const branch = patch.branch !== undefined ? patch.branch : prev.branch
  if (branch) next.branch = branch
  const subdir = patch.subdir !== undefined ? patch.subdir : prev.subdir
  if (subdir) next.subdir = subdir
  const disabledSkills = patch.disabledSkills !== undefined ? patch.disabledSkills : prev.disabledSkills
  if (disabledSkills?.length) next.disabledSkills = [...new Set(disabledSkills)].sort()
  const lastSync = patch.lastSync !== undefined ? patch.lastSync : prev.lastSync
  if (lastSync !== undefined) next.lastSync = lastSync
  if ("lastError" in patch) {
    if (patch.lastError !== undefined) next.lastError = patch.lastError
    // else: intentionally omit lastError (clear)
  } else if (prev.lastError !== undefined) {
    next.lastError = prev.lastError
  }
  repos[idx] = next
  save({ ...s, skillRepos: repos })
  return next
}
