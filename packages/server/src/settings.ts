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
export const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"]

export function isEffort(value: unknown): value is Effort {
  return typeof value === "string" && EFFORTS.includes(value as Effort)
}

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

/** The persistent sidekick: the cheaper worker model the lead hands briefs to
 *  (one standing side thread per session — see ThreadManager.delegateToSidekick).
 *  Absent provider/model => the sidekick inherits the active selection, so the
 *  tool still works (context isolation alone is worth it) until a seat is set.
 *  `enabled: false` is the MASTER switch — it disables the whole sidekick
 *  system, named seats included. */
export interface SidekickConfig {
  enabled: boolean
  provider?: string
  model?: string
  effort?: Effort
}

/** A NAMED sidekick seat (e.g. "frontend", "backend"): a domain-scoped worker
 *  with its own persistent thread, so each domain accumulates its own context
 *  (the frontend seat learns the UI, the backend seat learns the server).
 *  Presence = configured; deletion = seat gone. The default seat stays in
 *  SidekickConfig for back-compat. */
export interface SidekickSeat {
  provider: string
  model: string
  effort?: Effort
}

/** A named executor+sidekick+advisor trio (see /mode). The seats are part of the
 *  mode on purpose: which pairing works depends on the executor (e.g. a Fable
 *  executor should NOT pair with a Fable advisor — advisorFor suppresses
 *  same-model pairs — so the Fable mode names a different advisor). */
export interface ModeSpec {
  provider: string
  model: string
  effort?: Effort
  speed?: Speed
  /** The paired advisor; null = advisor off in this mode. */
  advisor?: { provider: string; model: string; effort?: Effort } | null
  /** The paired sidekick; null = sidekick seat unset in this mode (inherit). */
  sidekick?: { provider: string; model: string; effort?: Effort } | null
  /** Named sidekick seats; null = clear all named seats in this mode;
   *  absent (undefined) = mode predates seats, leave them alone. */
  sidekickSeats?: Record<string, SidekickSeat> | null
}

export interface Settings {
  /** Repository-scoped instruction loading. Missing entries are enabled. */
  repositoryInstructions?: Record<string, { agentsMd?: boolean }>
  fileToolProfile?: "standard" | "hashline"
  /** User/project skill names disabled globally. */
  disabledSkills?: string[]
  customProviders?: CustomProvider[]
  onboardedAt?: number
  /** Active provider id. */
  provider?: string
  /** provider id -> that provider's last selection. */
  selections?: Record<string, ModelSelection>
  /** The advisor's model + on/off state. */
  advisor?: AdvisorConfig
  /** The sidekick's model + on/off state (the DEFAULT seat + master switch). */
  sidekick?: SidekickConfig
  /** Named sidekick seats (e.g. frontend/backend), each its own persistent thread. */
  sidekickSeats?: Record<string, SidekickSeat>
  /** Cold-cache send guard threshold in tokens (see getCacheGuardTokens).
   *  Absent = default; null = guard off. */
  cacheGuardTokens?: number | null
  /** Named executor+advisor pairings, applied as one unit via /mode. */
  modes?: Record<string, ModeSpec>
  /** Builtin modes already seeded; deletion of one is permanent. */
  seededModes?: string[]
  /** Global provider catalog overlays. Added ids supplement provider discovery;
   *  hidden ids disappear from pickers without invalidating existing sessions. */
  modelCatalog?: Record<string, ModelCatalogOverlay>
  /** Bearer token required from non-loopback HTTP clients (see index.ts).
   *  Generated on first use; settings.json is gitignored, so it stays local. */
  serverToken?: string
  /** Managed skill git repositories (cloned under stateDir/skill-repos/). */
  skillRepos?: SkillRepoRecord[]
  /** Optional user exceptions to Chunky's zero-config workflow routing. Keys are provider/model. */
  workflowTargets?: Record<string, WorkflowTargetOverride>
}

export function agentsMdEnabled(repo: string): boolean {
  return loadSettings().repositoryInstructions?.[repo]?.agentsMd !== false
}

export function setAgentsMdEnabled(repo: string, enabled: boolean): boolean {
  const s = loadSettings()
  const repositoryInstructions = { ...(s.repositoryInstructions ?? {}) }
  repositoryInstructions[repo] = { ...(repositoryInstructions[repo] ?? {}), agentsMd: enabled }
  save({ ...s, repositoryInstructions })
  return enabled
}
export type FileToolProfile = "standard" | "hashline"
export function resolveFileToolProfile(): FileToolProfile {
  const env = process.env.CHUNKY_FILE_TOOL_PROFILE
  if (env === "hashline" || env === "standard") return env
  const setting = loadSettings().fileToolProfile
  return setting === "hashline" || setting === "standard" ? setting : "standard"
}
export interface CustomProvider {
  id: string
  label: string
  baseURL: string
  billing?: "subscription" | "metered"
  defaultModel?: string
}

export interface WorkflowTargetOverride {
  tags?: string[]
  automatic?: boolean
  effort?: Effort
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

export function workflowTargetKey(provider: string, model: string): string {
  return `${provider}/${model}`
}

export function normalizeWorkflowTags(tags: string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean))]
}

export function workflowTargetOverrides(): Record<string, WorkflowTargetOverride> {
  return { ...(loadSettings().workflowTargets ?? {}) }
}

export function setWorkflowTargetOverride(
  provider: string,
  model: string,
  patch: WorkflowTargetOverride | null,
): WorkflowTargetOverride | null {
  const s = loadSettings()
  const workflowTargets = { ...(s.workflowTargets ?? {}) }
  const key = workflowTargetKey(provider, model)
  if (patch === null) {
    delete workflowTargets[key]
    save({ ...s, workflowTargets })
    return null
  }
  const previous = workflowTargets[key] ?? {}
  const next: WorkflowTargetOverride = {
    ...previous,
    ...(patch.tags !== undefined ? { tags: normalizeWorkflowTags(patch.tags) } : {}),
    ...(patch.automatic !== undefined ? { automatic: patch.automatic } : {}),
    ...(patch.effort !== undefined ? { effort: patch.effort } : {}),
  }
  workflowTargets[key] = next
  save({ ...s, workflowTargets })
  return next
}

function settingsPath(): string {
  return process.env.CHUNKY_SETTINGS || "settings.json"
}

let cache: Settings | undefined
let cacheFile: string | undefined

export function loadSettings(): Settings {
  const p = settingsPath()
  // The path is configurable and is often set by embedders/tests after module
  // imports have begun. Do not let a prior file's cache leak across paths.
  if (cache && cacheFile === p) return cache
  cacheFile = p
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

export function getOnboardedAt(): number | undefined { return loadSettings().onboardedAt }
export function setOnboardedAt(value = Date.now()): number {
  save({ ...loadSettings(), onboardedAt: value }); return value
}
export function saveCustomProviders(customProviders: CustomProvider[]): void {
  save({ ...loadSettings(), customProviders })
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
  const modes = loadSettings().modes ?? {}
  const key = Object.keys(modes).find((candidate) => candidate.toLowerCase() === name.toLowerCase())
  return key ? modes[key] : undefined
}

export function saveMode(name: string, spec: ModeSpec): void {
  const s = loadSettings()
  save({ ...s, modes: { ...(s.modes ?? {}), [name]: spec } })
}

export function markSeededModes(names: string[]): void {
  save({ ...loadSettings(), seededModes: names })
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

/** The CURRENT trio as a ModeSpec — what "/mode save <name>" would snapshot:
 *  the active provider's selection plus the advisor and sidekick (each null when
 *  off/unconfigured). */
export function currentModeSpec(): ModeSpec {
  const s = loadSettings()
  const provider = s.provider ?? ""
  const sel = s.selections?.[provider] ?? {}
  const adv = getAdvisor()
  const side = getSidekick()
  return {
    provider,
    model: sel.model ?? "",
    ...(sel.effort ? { effort: sel.effort } : {}),
    ...(sel.speed ? { speed: sel.speed } : {}),
    advisor:
      adv.enabled && adv.provider && adv.model
        ? { provider: adv.provider, model: adv.model, ...(adv.effort ? { effort: adv.effort } : {}) }
        : null,
    sidekick:
      side.enabled && side.provider && side.model
        ? { provider: side.provider, model: side.model, ...(side.effort ? { effort: side.effort } : {}) }
        : null,
    sidekickSeats: Object.keys(getSidekickSeats()).length > 0 ? getSidekickSeats() : null,
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

/** The sidekick config (default `{ enabled: true }` when never set — enabled and
 *  usable immediately: an unconfigured seat inherits the active selection). */
export function getSidekick(): SidekickConfig {
  return loadSettings().sidekick ?? { enabled: true }
}

/** Reset the sidekick seat to the default: enabled, no provider/model — i.e.
 *  inherit the active selection (see sidekickFor). */
export function resetSidekickSeat(): SidekickConfig {
  const s = loadSettings()
  const next: SidekickConfig = { enabled: true }
  save({ ...s, sidekick: next })
  return next
}

/** Merge-update the sidekick config (only defined fields overwrite) and persist. */
export function setSidekick(patch: Partial<SidekickConfig>): SidekickConfig {
  const s = loadSettings()
  const prev = s.sidekick ?? { enabled: true }
  const next: SidekickConfig = {
    ...prev,
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    ...(patch.provider !== undefined ? { provider: patch.provider } : {}),
    ...(patch.model !== undefined ? { model: patch.model } : {}),
    ...(patch.effort !== undefined ? { effort: patch.effort } : {}),
  }
  save({ ...s, sidekick: next })
  return next
}

// ---- Named sidekick seats (e.g. frontend/backend) ----

/** Seat names must be short lowercase slugs: they become thread-id suffixes
 *  (`<root>:sidekick:<name>`) and a tool-call enum the lead types verbatim. */
export function isValidSeatName(name: string): boolean {
  return /^[a-z][a-z0-9_-]{0,23}$/.test(name) && name !== "default"
}

/** All configured named seats (empty object when none). */
export function getSidekickSeats(): Record<string, SidekickSeat> {
  return loadSettings().sidekickSeats ?? {}
}

/** Set (spec) or delete (null) one named seat and persist. Returns the map. */
export function setSidekickSeat(name: string, spec: SidekickSeat | null): Record<string, SidekickSeat> {
  const s = loadSettings()
  const seats = { ...(s.sidekickSeats ?? {}) }
  if (spec) seats[name] = spec
  else delete seats[name]
  save({ ...s, sidekickSeats: seats })
  return seats
}

/** Replace ALL named seats at once (mode apply). */
export function setSidekickSeats(seats: Record<string, SidekickSeat>): void {
  const s = loadSettings()
  save({ ...s, sidekickSeats: seats })
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

export function saveDisabledSkills(names: string[]): void {
  const s = loadSettings()
  save({ ...s, disabledSkills: [...new Set(names)].sort() })
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
