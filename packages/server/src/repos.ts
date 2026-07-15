// Repo registry: the set of local folders the GUI can point Chunky at, plus a
// persisted DEFAULT repo (activeId). Persisted to <state>/repos.json so it
// survives restarts.
//
// NOTE: activeId is a client convenience only — the default for session creation
// when no repoId is supplied (e.g. the TUI). It carries NO execution state:
// every session stores its own workspace at creation (Store), and every run
// resolves its workspace from its session. Selecting a repo here never
// retargets in-flight runs and never invalidates agents — sessions in different
// repos run concurrently.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { LAUNCH_WORKSPACE } from "./workspace.ts"

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
export function stateDir(): string {
  const settings = process.env.CHUNKY_SETTINGS
  if (settings) return dirname(settings)
  const db = process.env.CHUNKY_DB
  if (db && (db.includes("/") || db.includes("\\"))) return dirname(resolve(db))
  return process.cwd()
}

const REGISTRY_FILE = join(stateDir(), "repos.json")

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

/** The DEFAULT repo for clients that don't pass one (e.g. the TUI). */
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

/** Persist a repo as the default for repo-less session creation. Pure
 *  preference — touches no in-flight run and no cached agent. */
export function selectRepo(id: string): Repo {
  const reg = load()
  const repo = reg.repos.find((r) => r.id === id)
  if (!repo) throw new Error(`unknown repo: ${id}`)
  reg.activeId = id
  save()
  return repo
}

/** Remove a repo from the list (does NOT delete the folder). The launch
 *  workspace can't be removed — it's the fallback if the default one goes away. */
export function removeRepo(id: string): Registry {
  const reg = load()
  const boot = makeRepo(LAUNCH_WORKSPACE)
  reg.repos = reg.repos.filter((r) => r.id !== id || r.id === boot.id)
  if (!reg.repos.some((r) => r.id === reg.activeId)) {
    reg.activeId = boot.id
  }
  save()
  return listRepos()
}
