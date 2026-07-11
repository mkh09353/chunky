// Repo registry: the set of local folders the GUI can point Chunky at, plus
// which one is active. Persisted to <state>/repos.json so it survives restarts.
// Switching a repo retargets WORKSPACE (see workspace.ts) and drops cached
// agents so the next turn rebuilds with the new cwd in its prompt. Sessions are
// scoped by workspace path in the Store, so each repo gets its own thread list.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { LAUNCH_WORKSPACE, WORKSPACE, setWorkspace } from "./workspace.ts"
import { invalidateAgent } from "./agent.ts"

export interface Repo {
  id: string
  path: string
  name: string
  addedAt: number
}

interface Registry {
  repos: Repo[]
  activeId: string | null
}

/** Where repos.json lives — next to settings.json / the sqlite db, else cwd. */
function stateDir(): string {
  const settings = process.env.CHUNKY_SETTINGS
  if (settings) return dirname(settings)
  const db = process.env.CHUNKY_DB
  if (db && (db.includes("/") || db.includes("\\"))) return dirname(resolve(db))
  return process.cwd()
}

const REGISTRY_FILE = join(stateDir(), "repos.json")

/** Stable id from a resolved path (djb2 → base36) so re-adding the same folder
 *  dedupes to one entry and ids stay consistent across restarts. */
function repoId(path: string): string {
  let h = 5381
  for (let i = 0; i < path.length; i++) h = ((h << 5) + h + path.charCodeAt(i)) | 0
  return "r" + (h >>> 0).toString(36)
}

function makeRepo(path: string, addedAt = Date.now()): Repo {
  const abs = resolve(path)
  return { id: repoId(abs), path: abs, name: basename(abs) || abs, addedAt }
}

let registry: Registry | null = null

function load(): Registry {
  if (registry) return registry
  const reg: Registry = { repos: [], activeId: null }
  try {
    if (existsSync(REGISTRY_FILE)) {
      const parsed = JSON.parse(readFileSync(REGISTRY_FILE, "utf8")) as Partial<Registry>
      if (Array.isArray(parsed.repos)) {
        reg.repos = parsed.repos.filter(
          (r): r is Repo =>
            !!r && typeof r.id === "string" && typeof r.path === "string",
        )
        reg.activeId = typeof parsed.activeId === "string" ? parsed.activeId : null
      }
    }
  } catch {
    /* corrupt file → start fresh */
  }
  // The launch workspace is always represented and is the safe fallback.
  const boot = makeRepo(LAUNCH_WORKSPACE)
  if (!reg.repos.some((r) => r.id === boot.id)) reg.repos.unshift(boot)
  if (!reg.activeId || !reg.repos.some((r) => r.id === reg.activeId)) reg.activeId = boot.id
  registry = reg
  return reg
}

function save(): void {
  if (!registry) return
  try {
    mkdirSync(stateDir(), { recursive: true })
    writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2))
  } catch {
    /* best-effort persistence */
  }
}

/** {repos, activeId} for the GUI, most-recently-added first. */
export function listRepos(): Registry {
  const reg = load()
  return {
    repos: reg.repos.slice().sort((a, b) => b.addedAt - a.addedAt),
    activeId: reg.activeId,
  }
}

export function activeRepo(): Repo | null {
  const reg = load()
  return reg.repos.find((r) => r.id === reg.activeId) ?? null
}

export function repoById(id: string): Repo | null {
  return load().repos.find((r) => r.id === id) ?? null
}

/** Validate + add a folder. Throws if it isn't a directory. Idempotent by path. */
export function addRepo(path: string): Repo {
  const abs = resolve(path)
  if (!existsSync(abs) || !statSync(abs).isDirectory()) {
    throw new Error(`not a directory: ${abs}`)
  }
  const reg = load()
  const repo = makeRepo(abs)
  const existing = reg.repos.find((r) => r.id === repo.id)
  if (existing) return existing
  reg.repos.push(repo)
  save()
  return repo
}

/** Make a repo active: retarget the workspace + drop cached agents so the next
 *  turn (and file index) operate on the new folder. */
export function selectRepo(id: string): Repo {
  const reg = load()
  const repo = reg.repos.find((r) => r.id === id)
  if (!repo) throw new Error(`unknown repo: ${id}`)
  reg.activeId = id
  save()
  setWorkspace(repo.path)
  invalidateAgent()
  return repo
}

/** Remove a repo from the list (does NOT delete the folder). The launch
 *  workspace can't be removed — it's the fallback if the active one goes away. */
export function removeRepo(id: string): Registry {
  const reg = load()
  const boot = makeRepo(LAUNCH_WORKSPACE)
  reg.repos = reg.repos.filter((r) => r.id !== id || r.id === boot.id)
  if (!reg.repos.some((r) => r.id === reg.activeId)) {
    reg.activeId = boot.id
    setWorkspace(boot.path)
    invalidateAgent()
  }
  save()
  return listRepos()
}

/** Restore the persisted active repo at boot so the GUI's last choice sticks
 *  across restarts. Called once at startup AFTER the Store has backfilled
 *  pre-existing sessions to the launch workspace. */
export function initRepos(): void {
  const reg = load()
  const active = reg.repos.find((r) => r.id === reg.activeId)
  if (active && existsSync(active.path) && active.path !== WORKSPACE) {
    setWorkspace(active.path)
    invalidateAgent()
  }
}
