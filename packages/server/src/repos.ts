// Repo registry: the set of local folders the GUI shows as tabs, plus a
// persisted DEFAULT repo (activeId). Persisted to <state>/repos.json so it
// survives restarts, app updates and reinstalls.
//
// NOTE: activeId is a client convenience only — the default for session creation
// when no repoId is supplied (e.g. the TUI). It carries NO execution state:
// every session stores its own workspace at creation (Store), and every run
// resolves its workspace from its session. Selecting a repo here never
// retargets in-flight runs and never invalidates agents — sessions in different
// repos run concurrently.
//
// CONCURRENCY: several compatible Chunky servers (one per workspace, plus the
// desktop app's) legitimately share one state directory and therefore one
// repos.json. A process-cached registry written back wholesale would silently
// drop repos another server added and resurrect ones it removed, so every
// mutation re-reads the file, merges by repo id, and publishes the result with
// a temp-file rename (the same discipline as settings.ts).
//
// TOMBSTONES: a removal is recorded in `removed[]`. Without it, load()
// re-adding the launch workspace (or another server's stale copy of the list)
// would resurrect a tab the user deliberately closed. Explicitly adding a
// folder again clears its tombstone.
import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { LAUNCH_WORKSPACE } from "./workspace.ts"

export interface Repo {
  id: string
  path: string
  name: string
  addedAt: number
}

/** A repo the user removed. Kept so nothing re-adds it behind their back. */
export interface RemovedRepo {
  id: string
  path: string
  removedAt: number
}

interface Registry {
  repos: Repo[]
  activeId: string | null
  removed: RemovedRepo[]
}

/** Where repos.json lives — next to settings.json / the sqlite db, else the
 *  desktop state directory. It must NEVER fall back to the process cwd: that
 *  silently gives every folder its own registry, so the tabs a user sees would
 *  depend on which server the client happened to attach to. */
export function stateDir(): string {
  const settings = process.env.CHUNKY_SETTINGS
  if (settings) return dirname(resolve(settings))
  const db = process.env.CHUNKY_DB
  if (db && (db.includes("/") || db.includes("\\"))) return dirname(resolve(db))
  const home = process.env.CHUNKY_HOME
  if (home) return resolve(home)
  return join(homedir(), ".chunky", "state")
}

function registryFile(): string {
  return join(stateDir(), "repos.json")
}

/** The workspace this server was launched in. Read per call (not frozen at
 *  import) so tests and embedders can point it somewhere else. */
function bootWorkspace(): string {
  return resolve(process.env.CHUNKY_WORKSPACE || LAUNCH_WORKSPACE)
}

/** Stable id from a resolved path (djb2 → base36) so re-adding the same folder
 *  dedupes to one entry and ids stay consistent across restarts. */
export function repoId(path: string): string {
  let h = 5381
  for (let i = 0; i < path.length; i++) h = ((h << 5) + h + path.charCodeAt(i)) | 0
  return "r" + (h >>> 0).toString(36)
}

function makeRepo(path: string, addedAt = Date.now()): Repo {
  const abs = resolve(path)
  return { id: repoId(abs), path: abs, name: basename(abs) || abs, addedAt }
}

// ---- Parsing (never throws; a corrupt entry is skipped, not fatal) ---------

function sanitizeRepo(value: unknown): Repo | null {
  if (!value || typeof value !== "object") return null
  const r = value as Partial<Repo>
  if (typeof r.id !== "string" || !r.id) return null
  if (typeof r.path !== "string" || !r.path) return null
  return {
    id: r.id,
    path: r.path,
    name: typeof r.name === "string" && r.name ? r.name : basename(r.path) || r.path,
    addedAt: typeof r.addedAt === "number" && Number.isFinite(r.addedAt) ? r.addedAt : 0,
  }
}

function sanitizeRemoved(value: unknown): RemovedRepo | null {
  if (!value || typeof value !== "object") return null
  const t = value as Partial<RemovedRepo>
  if (typeof t.id !== "string" || !t.id) return null
  return {
    id: t.id,
    path: typeof t.path === "string" ? t.path : "",
    // A tombstone without a usable timestamp must still suppress: treat it as
    // "removed now", which beats every already-persisted addedAt.
    removedAt:
      typeof t.removedAt === "number" && Number.isFinite(t.removedAt) ? t.removedAt : Date.now(),
  }
}

function emptyRegistry(): Registry {
  return { repos: [], activeId: null, removed: [] }
}

/** The on-disk registry, or null when the file is absent/unreadable/corrupt
 *  (null means "no persisted state yet" → first-run seeding applies). */
function readRegistry(file: string): Registry | null {
  try {
    if (!existsSync(file)) return null
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"))
    if (!parsed || typeof parsed !== "object") return null
    const raw = parsed as Partial<Registry>
    const repos: Repo[] = []
    const seen = new Set<string>()
    for (const entry of Array.isArray(raw.repos) ? raw.repos : []) {
      const repo = sanitizeRepo(entry)
      if (!repo || seen.has(repo.id)) continue
      seen.add(repo.id)
      repos.push(repo)
    }
    // Registries written before tombstones existed simply have no `removed`.
    const removed: RemovedRepo[] = []
    for (const entry of Array.isArray(raw.removed) ? raw.removed : []) {
      const tombstone = sanitizeRemoved(entry)
      if (tombstone) removed.push(tombstone)
    }
    return {
      repos,
      activeId: typeof raw.activeId === "string" ? raw.activeId : null,
      removed,
    }
  } catch {
    return null
  }
}

// ---- Merge ----------------------------------------------------------------

/** Newest tombstone per id, from both sides. */
function mergeTombstones(...lists: RemovedRepo[][]): Map<string, RemovedRepo> {
  const out = new Map<string, RemovedRepo>()
  for (const list of lists) {
    for (const tombstone of list) {
      const prev = out.get(tombstone.id)
      if (!prev || tombstone.removedAt > prev.removedAt) out.set(tombstone.id, tombstone)
    }
  }
  return out
}

/**
 * Combine what is on disk (another server may have written it since) with what
 * this process last saw. Disk wins for entries present in both; entries only
 * this process knows about are kept unless a tombstone removed them afterwards.
 */
function mergeRegistries(disk: Registry, cached: Registry | null): Registry {
  const tombstones = mergeTombstones(cached?.removed ?? [], disk.removed)
  const repos = new Map<string, Repo>()
  for (const repo of [...disk.repos, ...(cached?.repos ?? [])]) {
    if (repos.has(repo.id)) continue
    const tombstone = tombstones.get(repo.id)
    // The tombstone only suppresses entries that predate the removal; a folder
    // explicitly added again (fresh addedAt) legitimately comes back.
    if (tombstone && tombstone.removedAt >= repo.addedAt) continue
    repos.set(repo.id, repo)
  }
  for (const id of repos.keys()) tombstones.delete(id)
  const candidates = [disk.activeId, cached?.activeId ?? null]
  return {
    repos: [...repos.values()],
    activeId: candidates.find((id) => !!id && repos.has(id)) ?? null,
    removed: [...tombstones.values()],
  }
}

/** The launch workspace is represented by default — but never against the
 *  user's wishes: a tombstone for it keeps it out of the list. */
function seedBootWorkspace(reg: Registry): Registry {
  const boot = makeRepo(bootWorkspace())
  const tombstoned = reg.removed.some((t) => t.id === boot.id)
  if (!tombstoned && !reg.repos.some((r) => r.id === boot.id)) reg.repos.unshift(boot)
  if (!reg.activeId || !reg.repos.some((r) => r.id === reg.activeId)) {
    reg.activeId = reg.repos.some((r) => r.id === boot.id) ? boot.id : (reg.repos[0]?.id ?? null)
  }
  return reg
}

// ---- Cache (invalidated whenever the file changes underneath us) ----------

let cache: Registry | null = null
let cacheFile: string | undefined
let cacheStamp: string | undefined

function fileStamp(file: string): string {
  try {
    const s = statSync(file)
    return `${s.mtimeMs}:${s.size}`
  } catch {
    return "absent"
  }
}

function load(): Registry {
  const file = registryFile()
  const stamp = fileStamp(file)
  if (cache && cacheFile === file && cacheStamp === stamp) return cache
  const disk = readRegistry(file)
  const merged = seedBootWorkspace(
    mergeRegistries(disk ?? emptyRegistry(), cacheFile === file ? cache : null),
  )
  cache = merged
  cacheFile = file
  cacheStamp = stamp
  return merged
}

function write(file: string, reg: Registry): void {
  try {
    mkdirSync(dirname(file), { recursive: true })
    // rename within the state directory is atomic, so a concurrent reader sees
    // either the old complete JSON document or the new one, never a partial
    // write from a process that died mid-save.
    const temporary = `${file}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`
    try {
      writeFileSync(temporary, JSON.stringify(reg, null, 2))
      renameSync(temporary, file)
    } catch (err) {
      rmSync(temporary, { force: true })
      throw err
    }
  } catch (err) {
    console.warn(`[@chunky/server] could not persist repos: ${(err as Error).message}`)
  }
}

/**
 * Read-modify-write: re-read the registry, merge this process's view into it,
 * apply the mutation and publish atomically. `apply` may throw to abort before
 * anything is written.
 */
function mutate<T>(apply: (reg: Registry) => T): T {
  const file = registryFile()
  const disk = readRegistry(file)
  const base = seedBootWorkspace(
    mergeRegistries(disk ?? emptyRegistry(), cacheFile === file ? cache : null),
  )
  const result = apply(base)
  if (!base.activeId || !base.repos.some((r) => r.id === base.activeId)) {
    base.activeId = base.repos[0]?.id ?? null
  }
  write(file, base)
  cache = base
  cacheFile = file
  cacheStamp = fileStamp(file)
  return result
}

// ---- Public API -----------------------------------------------------------

/** {repos, activeId} for the GUI, most-recently-added first. Entries whose
 *  folder no longer exists are kept (an unmounted volume must not silently
 *  close a tab) and nothing here touches the filesystem, so a stale path can
 *  never make this throw. */
export function listRepos(): { repos: Repo[]; activeId: string | null } {
  const reg = load()
  return {
    repos: reg.repos.slice().sort((a, b) => b.addedAt - a.addedAt),
    activeId: reg.activeId,
  }
}

/** The DEFAULT repo for clients that don't pass one (e.g. the TUI). */
export function activeRepo(): Repo | null {
  const reg = load()
  return reg.repos.find((r) => r.id === reg.activeId) ?? null
}

export function repoById(id: string): Repo | null {
  return load().repos.find((r) => r.id === id) ?? null
}

/** Validate + add a folder. Throws if it isn't a directory. Idempotent by path.
 *  An explicit add is the user's intent, so it clears any tombstone. */
export function addRepo(path: string): Repo {
  const abs = resolve(path)
  let directory = false
  try {
    directory = statSync(abs).isDirectory()
  } catch {
    directory = false
  }
  if (!directory) throw new Error(`not a directory: ${abs}`)
  const id = repoId(abs)
  return mutate((reg) => {
    reg.removed = reg.removed.filter((t) => t.id !== id)
    const existing = reg.repos.find((r) => r.id === id)
    if (existing) return existing
    const repo = makeRepo(abs)
    reg.repos.push(repo)
    return repo
  })
}

/** Persist a repo as the default for repo-less session creation. Pure
 *  preference — touches no in-flight run and no cached agent. */
export function selectRepo(id: string): Repo {
  return mutate((reg) => {
    const repo = reg.repos.find((r) => r.id === id)
    if (!repo) throw new Error(`unknown repo: ${id}`)
    reg.activeId = id
    return repo
  })
}

/** Remove a repo from the list (does NOT delete the folder). Any repo can be
 *  removed, the launch workspace included: the tombstone is what stops the next
 *  server launched in that folder from re-adding it. */
export function removeRepo(id: string): { repos: Repo[]; activeId: string | null } {
  mutate((reg) => {
    const repo = reg.repos.find((r) => r.id === id)
    reg.repos = reg.repos.filter((r) => r.id !== id)
    reg.removed = [
      ...reg.removed.filter((t) => t.id !== id),
      { id, path: repo?.path ?? "", removedAt: Date.now() },
    ]
  })
  return listRepos()
}

/** Test-only: drop the process cache so a test can simulate a fresh server. */
export function resetRegistryCacheForTest(): void {
  cache = null
  cacheFile = undefined
  cacheStamp = undefined
}
