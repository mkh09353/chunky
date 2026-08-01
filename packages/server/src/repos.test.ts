// Repo registry durability: the desktop's top tabs are this file's contents, so
// a mutation must never lose another server's writes and a removal must stay
// removed across restarts.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"

const dir = mkdtempSync(join(tmpdir(), "chunky-repos-test-"))
const bootWorkspace = join(dir, "boot")
mkdirSync(bootWorkspace, { recursive: true })

// bun test shares one process across files, so this file's environment is
// applied per test and handed straight back: a leaked CHUNKY_SETTINGS would
// point another file's settings writes into this test's temp directory.
const inherited = {
  settings: process.env.CHUNKY_SETTINGS,
  workspace: process.env.CHUNKY_WORKSPACE,
  db: process.env.CHUNKY_DB,
  home: process.env.CHUNKY_HOME,
}

function restoreVariable(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

function applyTestEnv(): void {
  process.env.CHUNKY_SETTINGS = join(dir, "settings.json")
  process.env.CHUNKY_WORKSPACE = bootWorkspace
  delete process.env.CHUNKY_DB
  delete process.env.CHUNKY_HOME
}

function restoreInheritedEnv(): void {
  restoreVariable("CHUNKY_SETTINGS", inherited.settings)
  restoreVariable("CHUNKY_WORKSPACE", inherited.workspace)
  restoreVariable("CHUNKY_DB", inherited.db)
  restoreVariable("CHUNKY_HOME", inherited.home)
}

const {
  addRepo,
  activeRepo,
  listRepos,
  removeRepo,
  repoById,
  repoId,
  resetRegistryCacheForTest,
  selectRepo,
  stateDir,
} = await import("./repos.ts")

const registry = join(dir, "repos.json")
const bootId = repoId(resolve(bootWorkspace))

afterAll(() => rmSync(dir, { recursive: true, force: true }))

interface OnDisk {
  repos: { id: string; path: string; name: string; addedAt: number }[]
  activeId: string | null
  removed?: { id: string; path: string; removedAt: number }[]
}

function onDisk(): OnDisk {
  return JSON.parse(readFileSync(registry, "utf8")) as OnDisk
}

/** A folder that exists on disk, for adding as a repo. */
function folder(name: string): string {
  const path = join(dir, name)
  mkdirSync(path, { recursive: true })
  return path
}

/** Simulate ANOTHER Chunky server writing the shared registry: this process
 *  learns about it only by re-reading the file. */
function otherServerWrites(next: OnDisk): void {
  writeFileSync(registry, JSON.stringify(next, null, 2))
}

/** Simulate a server restart (fresh process, empty in-memory registry). */
function restart(workspace = bootWorkspace): void {
  process.env.CHUNKY_WORKSPACE = workspace
  resetRegistryCacheForTest()
}

beforeEach(() => {
  applyTestEnv()
  rmSync(registry, { force: true })
  restart()
})

afterEach(() => {
  restoreInheritedEnv()
  resetRegistryCacheForTest()
})

describe("first run", () => {
  test("seeds the launch workspace when no registry file exists", () => {
    const { repos, activeId } = listRepos()
    expect(repos.map((r) => r.id)).toEqual([bootId])
    expect(activeId).toBe(bootId)
    expect(activeRepo()?.path).toBe(resolve(bootWorkspace))
    // Reading must not create the file; only mutations persist.
    expect(existsSync(registry)).toBe(false)
  })
})

describe("atomic persistence", () => {
  test("publishes by temp-file rename and leaves no partial files", () => {
    addRepo(folder("alpha"))
    expect(onDisk().repos.some((r) => r.name === "alpha")).toBe(true)
    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([])
  })

  test("survives a restart: added repos and the default selection persist", () => {
    const alpha = addRepo(folder("alpha"))
    const beta = addRepo(folder("beta"))
    selectRepo(beta.id)

    restart()
    const { repos, activeId } = listRepos()
    expect(repos.map((r) => r.id).sort()).toEqual([alpha.id, beta.id, bootId].sort())
    expect(activeId).toBe(beta.id)
  })

  test("rejects a path that is not a directory without throwing on a missing one", () => {
    expect(() => addRepo(join(dir, "does-not-exist"))).toThrow("not a directory")
  })
})

describe("concurrent writers", () => {
  test("a stale writer does not drop a repo another server added", () => {
    const alpha = addRepo(folder("alpha")) // this process now holds a cached view

    // Another server (which never saw alpha) adds gamma and rewrites the file.
    const gammaPath = resolve(folder("gamma"))
    const gamma = { id: repoId(gammaPath), path: gammaPath, name: "gamma", addedAt: Date.now() }
    otherServerWrites({ repos: [gamma], activeId: gamma.id })

    // This process mutates from its stale view; nothing may be lost either way.
    const delta = addRepo(folder("delta"))

    const ids = onDisk().repos.map((r) => r.id)
    expect(ids).toContain(alpha.id)
    expect(ids).toContain(gamma.id)
    expect(ids).toContain(delta.id)
    expect(ids).toContain(bootId)
  })

  test("a stale writer does not resurrect a repo another server removed", () => {
    const alpha = addRepo(folder("alpha"))
    const beta = addRepo(folder("beta"))

    // Another server removes alpha, recording the tombstone.
    otherServerWrites({
      repos: [{ id: beta.id, path: beta.path, name: beta.name, addedAt: beta.addedAt }],
      activeId: beta.id,
      removed: [{ id: alpha.id, path: alpha.path, removedAt: Date.now() }],
    })

    // This process still has alpha cached; its next write must honour the removal.
    selectRepo(beta.id)

    expect(onDisk().repos.map((r) => r.id)).not.toContain(alpha.id)
    expect(listRepos().repos.map((r) => r.id)).not.toContain(alpha.id)
  })

  test("this process's removal survives another server's stale re-add", () => {
    const alpha = addRepo(folder("alpha"))
    removeRepo(alpha.id)

    // A stale server rewrites the file from a snapshot that still has alpha and
    // knows nothing about the tombstone.
    otherServerWrites({
      repos: [{ id: alpha.id, path: alpha.path, name: alpha.name, addedAt: alpha.addedAt }],
      activeId: alpha.id,
    })

    expect(listRepos().repos.map((r) => r.id)).not.toContain(alpha.id)
  })
})

describe("tombstones", () => {
  test("a removed repo stays removed across a restart", () => {
    const alpha = addRepo(folder("alpha"))
    removeRepo(alpha.id)
    expect(onDisk().removed?.map((t) => t.id)).toEqual([alpha.id])

    restart()
    expect(listRepos().repos.map((r) => r.id)).not.toContain(alpha.id)
  })

  test("the launch workspace can be removed and is not re-inserted on load", () => {
    const alpha = addRepo(folder("alpha"))
    const after = removeRepo(bootId)
    expect(after.repos.map((r) => r.id)).toEqual([alpha.id])
    expect(after.activeId).toBe(alpha.id)

    // A server booting in that very folder must not bring the tab back.
    restart(bootWorkspace)
    expect(listRepos().repos.map((r) => r.id)).toEqual([alpha.id])

    // Nor may a mutation re-seed it.
    addRepo(folder("beta"))
    expect(onDisk().repos.map((r) => r.id)).not.toContain(bootId)
  })

  test("explicitly adding a removed folder again clears its tombstone", () => {
    const alphaPath = folder("alpha")
    const alpha = addRepo(alphaPath)
    removeRepo(alpha.id)
    restart()
    expect(listRepos().repos.map((r) => r.id)).not.toContain(alpha.id)

    const readded = addRepo(alphaPath)
    expect(readded.id).toBe(alpha.id)
    expect(onDisk().removed ?? []).toEqual([])
    restart()
    expect(listRepos().repos.map((r) => r.id)).toContain(alpha.id)
  })

  test("removing every repo leaves an empty list rather than a phantom tab", () => {
    const alpha = addRepo(folder("alpha"))
    removeRepo(alpha.id)
    removeRepo(bootId)
    restart()
    expect(listRepos().repos).toEqual([])
    expect(listRepos().activeId).toBeNull()
    expect(activeRepo()).toBeNull()
  })
})

describe("migration and stale entries", () => {
  test("loads a legacy registry that has no removed[] field", () => {
    const legacyPath = resolve(folder("legacy"))
    otherServerWrites({
      repos: [{ id: repoId(legacyPath), path: legacyPath, name: "legacy", addedAt: 1 }],
      activeId: repoId(legacyPath),
    })
    restart()
    const { repos, activeId } = listRepos()
    expect(repos.map((r) => r.name).sort()).toEqual(["boot", "legacy"])
    expect(activeId).toBe(repoId(legacyPath))
  })

  test("keeps entries whose folder no longer exists instead of throwing", () => {
    const vanishing = folder("vanishing")
    const repo = addRepo(vanishing)
    rmSync(vanishing, { recursive: true, force: true })

    restart()
    expect(() => listRepos()).not.toThrow()
    expect(listRepos().repos.map((r) => r.id)).toContain(repo.id)
    expect(repoById(repo.id)?.path).toBe(resolve(vanishing))
    // Selecting a vanished repo is still a pure preference, not an error.
    expect(() => selectRepo(repo.id)).not.toThrow()
  })

  test("a corrupt registry falls back to first-run behaviour", () => {
    writeFileSync(registry, "{ not json")
    restart()
    expect(listRepos().repos.map((r) => r.id)).toEqual([bootId])
  })
})

describe("stateDir", () => {
  test("prefers CHUNKY_SETTINGS, then CHUNKY_DB, then CHUNKY_HOME, never cwd", () => {
    const settings = process.env.CHUNKY_SETTINGS
    const db = process.env.CHUNKY_DB
    const home = process.env.CHUNKY_HOME
    try {
      expect(stateDir()).toBe(dirOf(settings!))

      delete process.env.CHUNKY_SETTINGS
      process.env.CHUNKY_DB = join(dir, "db", "chunky.db")
      expect(stateDir()).toBe(join(dir, "db"))

      delete process.env.CHUNKY_DB
      process.env.CHUNKY_HOME = join(dir, "home-state")
      expect(stateDir()).toBe(join(dir, "home-state"))

      delete process.env.CHUNKY_HOME
      // The old cwd fallback split the registry per folder; the default is now
      // the one durable desktop state directory.
      expect(stateDir()).toBe(join(homedir(), ".chunky", "state"))
      expect(stateDir()).not.toBe(process.cwd())
    } finally {
      if (settings === undefined) delete process.env.CHUNKY_SETTINGS
      else process.env.CHUNKY_SETTINGS = settings
      if (db === undefined) delete process.env.CHUNKY_DB
      else process.env.CHUNKY_DB = db
      if (home === undefined) delete process.env.CHUNKY_HOME
      else process.env.CHUNKY_HOME = home
      resetRegistryCacheForTest()
    }
  })
})

function dirOf(path: string): string {
  return path.slice(0, path.lastIndexOf("/"))
}
