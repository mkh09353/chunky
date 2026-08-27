// Workspace snapshots without ever reading or writing the user's .git. The
// shadow repository stores only object/ref metadata; every command explicitly
// supplies a separate work tree and transient index.
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative, resolve } from "node:path"
import { spawn, spawnSync } from "node:child_process"
import { repoId, stateDir } from "./repos.ts"

/** Resolve existing paths through symlinks, while still accepting paths which
 * have not been created yet (such as a freshly-created restore target). */
function canonicalPath(path: string): string {
  const absolute = resolve(path)
  try { return realpathSync(absolute) } catch { return absolute }
}

function chunkyHome(): string {
  return canonicalPath(process.env.CHUNKY_HOME ?? join(process.env.HOME ?? process.cwd(), ".chunky"))
}

function shadowDir(workspace: string): string {
  return join(chunkyHome(), "state", "shadow", repoId(canonicalPath(workspace)))
}

/** A root-anchored git exclude for a Chunky-owned directory nested in a work
 * tree. Real paths are used for containment so symlink aliases cannot bypass it. */
function nestedDirectoryExclude(worktree: string, path: string): string | null {
  const root = canonicalPath(worktree)
  const child = canonicalPath(path)
  const rel = relative(root, child)
  if (!rel || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) return null
  return `/${rel.split("\\").join("/").replace(/\/+$/, "")}/`
}

/** Chunky's own state must never enter a snapshot, independent of .gitignore. */
function internalExcludes(worktree: string): string[] {
  return [...new Set([
    ".git",
    nestedDirectoryExclude(worktree, chunkyHome()),
    // Launcher configurations can place canonical state beside settings/DB.
    nestedDirectoryExclude(worktree, stateDir()),
  ].filter((entry): entry is string => !!entry))]
}

function git(sourceWorkspace: string, worktree: string, args: string[], index: string): string | null {
  const dir = shadowDir(sourceWorkspace)
  mkdirSync(dir, { recursive: true })
  const result = spawnSync("git", args, {
    cwd: worktree,
    encoding: "utf8",
    env: { ...process.env, GIT_DIR: dir, GIT_WORK_TREE: worktree, GIT_INDEX_FILE: index },
  })
  return result.status === 0 ? result.stdout.trim() : null
}

function withIndex<T>(workspace: string, fn: (index: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "chunky-shadow-index-"))
  const index = join(dir, "index")
  try { return fn(index) } finally { rmSync(dir, { recursive: true, force: true }) }
}

/** Serialize async snapshots of a workspace. Each snapshot has its own index,
 * but the lock keeps ref updates and worktree scans ordered for one workspace. */
const snapshotLocks = new Map<string, Promise<void>>()

async function withSnapshotLock<T>(workspace: string, fn: () => Promise<T>): Promise<T> {
  const key = canonicalPath(workspace)
  const previous = snapshotLocks.get(key) ?? Promise.resolve()
  let release!: () => void
  const current = previous.then(() => new Promise<void>((done) => { release = done }))
  snapshotLocks.set(key, current)
  await previous
  try {
    return await fn()
  } finally {
    release()
    if (snapshotLocks.get(key) === current) snapshotLocks.delete(key)
  }
}

function gitAsync(sourceWorkspace: string, worktree: string, args: string[], index: string): Promise<string | null> {
  const dir = shadowDir(sourceWorkspace)
  return new Promise((done) => {
    const child = spawn("git", args, {
      cwd: worktree,
      env: { ...process.env, GIT_DIR: dir, GIT_WORK_TREE: worktree, GIT_INDEX_FILE: index },
      stdio: ["ignore", "pipe", "ignore"],
    })
    let stdout = ""
    child.stdout.on("data", (chunk) => { stdout += chunk })
    child.once("error", () => done(null))
    child.once("close", (code) => done(code === 0 ? stdout.trim() : null))
  })
}

function ensureRepo(workspace: string, index: string): boolean {
  const dir = shadowDir(workspace)
  if (!existsSync(join(dir, "HEAD"))) {
    // Do not pass GIT_DIR while creating it: git init treats an existing
    // (empty) GIT_DIR as the repository itself rather than a bare destination.
    const init = spawnSync("git", ["init", "--bare", dir], { cwd: workspace, encoding: "utf8", env: process.env })
    if (init.status !== 0) return false
  }
  // info/exclude is inside the shadow git dir, never the user repository.
  mkdirSync(join(dir, "info"), { recursive: true })
  const exclude = join(dir, "info", "exclude")
  const existing = existsSync(exclude) ? readFileSync(exclude, "utf8").split(/\r?\n/).filter(Boolean) : []
  const missing = internalExcludes(workspace).filter((entry) => !existing.includes(entry))
  if (missing.length) writeFileSync(exclude, `${[...existing, ...missing].join("\n")}\n`)
  return true
}

/** Create a tree commit for the workspace and update refName. Null means git
 * was unavailable or the snapshot failed; callers must continue the turn. */
export function snapshotWorkspace(workspace: string, refName: string): string | null {
  workspace = canonicalPath(workspace)
  return withIndex(workspace, (index) => {
    if (!ensureRepo(workspace, index)) return null
    if (git(workspace, workspace, ["add", "-A"], index) == null) return null
    const tree = git(workspace, workspace, ["write-tree"], index)
    if (!tree) return null
    const commit = git(workspace, workspace, ["-c", "user.name=Chunky", "-c", "user.email=chunky@local", "commit-tree", tree, "-m", "Chunky snapshot"], index)
    if (!commit || git(workspace, workspace, ["update-ref", refName, commit], index) == null) return null
    return commit
  })
}

/** Asynchronous counterpart for message turns. It yields before doing any
 * filesystem work, keeping snapshotting entirely off the POST critical path. */
export async function snapshotWorkspaceAsync(workspace: string, refName: string): Promise<string | null> {
  workspace = canonicalPath(workspace)
  await Promise.resolve()
  return withSnapshotLock(workspace, async () => {
    const dir = mkdtempSync(join(tmpdir(), "chunky-shadow-index-"))
    const index = join(dir, "index")
    try {
      if (!ensureRepo(workspace, index)) return null
      if (await gitAsync(workspace, workspace, ["add", "-A"], index) == null) return null
      const tree = await gitAsync(workspace, workspace, ["write-tree"], index)
      if (!tree) return null
      const commit = await gitAsync(workspace, workspace, ["-c", "user.name=Chunky", "-c", "user.email=chunky@local", "commit-tree", tree, "-m", "Chunky snapshot"], index)
      if (!commit || await gitAsync(workspace, workspace, ["update-ref", refName, commit], index) == null) return null
      return commit
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
}

/** Restore a snapshot tree, including removal of files absent from the target. */
export function restoreSnapshot(workspace: string, commit: string, targetWorkspace = workspace): boolean {
  workspace = canonicalPath(workspace)
  targetWorkspace = canonicalPath(targetWorkspace)
  return withIndex(workspace, (index) => {
    if (!ensureRepo(workspace, index)) return false
    const target = git(workspace, targetWorkspace, ["rev-parse", `${commit}^{tree}`], index)
    if (!target) return false
    // Index current worktree first, then identify files to remove before the
    // target tree is checked out. This avoids touching the user's git index.
    if (git(workspace, targetWorkspace, ["add", "-A"], index) == null) return false
    const current = git(workspace, targetWorkspace, ["write-tree"], index)
    if (!current) return false
    const removed = git(workspace, targetWorkspace, ["diff", "--name-only", "--diff-filter=D", current, target], index)
    if (git(workspace, targetWorkspace, ["read-tree", target], index) == null) return false
    // Older commits may predate the exclusion. Keep their state paths out of
    // the transient index so checkout cannot overwrite a nested Chunky home.
    for (const exclude of internalExcludes(targetWorkspace)) {
      if (exclude === ".git") continue
      if (git(workspace, targetWorkspace, ["rm", "-r", "--cached", "--ignore-unmatch", "--", exclude.slice(1, -1)], index) == null) return false
    }
    if (git(workspace, targetWorkspace, ["checkout-index", "-a", "-f"], index) == null) return false
    const protectedPaths = internalExcludes(targetWorkspace)
      .filter((exclude) => exclude !== ".git")
      .map((exclude) => exclude.slice(1, -1))
    for (const file of (removed ?? "").split("\n").filter(Boolean)) {
      // Git paths are relative and therefore cannot escape the work tree.
      if (protectedPaths.some((path) => file === path || file.startsWith(`${path}/`))) continue
      rmSync(join(targetWorkspace, file), { force: true, recursive: true })
    }
    return true
  })
}
