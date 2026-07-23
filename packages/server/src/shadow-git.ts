// Workspace snapshots without ever reading or writing the user's .git. The
// shadow repository stores only object/ref metadata; every command explicitly
// supplies a separate work tree and transient index.
import { appendFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawn, spawnSync } from "node:child_process"
import { repoId } from "./repos.ts"

function shadowDir(workspace: string): string {
  const home = process.env.CHUNKY_HOME ?? join(process.env.HOME ?? process.cwd(), ".chunky")
  return join(home, "state", "shadow", repoId(resolve(workspace)))
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
  const key = resolve(workspace)
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
  // A work tree's .git must never become a snapshot entry even for a nested repo.
  if (!existsSync(exclude) || !readFileSync(exclude, "utf8").split(/\r?\n/).includes(".git")) appendFileSync(exclude, ".git\n")
  return true
}

/** Create a tree commit for the workspace and update refName. Null means git
 * was unavailable or the snapshot failed; callers must continue the turn. */
export function snapshotWorkspace(workspace: string, refName: string): string | null {
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
    if (git(workspace, targetWorkspace, ["checkout-index", "-a", "-f"], index) == null) return false
    for (const file of (removed ?? "").split("\n").filter(Boolean)) {
      // Git paths are relative and therefore cannot escape the work tree.
      rmSync(join(targetWorkspace, file), { force: true, recursive: true })
    }
    return true
  })
}
