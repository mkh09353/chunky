import { existsSync, mkdirSync, rmSync } from "node:fs"
import { basename, join, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { repoId } from "./repos.ts"

function gitOk(workspace: string, args: string[]): boolean {
  return spawnSync("git", args, { cwd: workspace, encoding: "utf8" }).status === 0
}

/** Creates and populates a fork worktree. On every failure it removes the
 * worktree and branch before returning null; callers persist no session first. */
export function createForkWorktree(workspace: string, childId: string, restore: (target: string) => boolean): { path: string; branch: string; gitCommonDir: string } | null {
  if (!gitOk(workspace, ["rev-parse", "--is-inside-work-tree"])) return null
  const slug = basename(resolve(workspace)).replace(/[^a-zA-Z0-9._-]+/g, "-") || "workspace"
  const branch = `chunky/${slug}-${childId.slice(0, 8)}`
  const home = process.env.CHUNKY_HOME ?? join(process.env.HOME ?? process.cwd(), ".chunky")
  const path = join(home, "state", "worktrees", repoId(resolve(workspace)), `${slug}-${childId.slice(0, 8)}`)
  const gitCommonDir = spawnSync("git", ["rev-parse", "--git-common-dir"], { cwd: workspace, encoding: "utf8" }).stdout.trim()
  mkdirSync(join(home, "state", "worktrees", repoId(resolve(workspace))), { recursive: true })
  if (!gitOk(workspace, ["worktree", "add", "-b", branch, path, "HEAD"])) return null
  if (restore(path)) return { path, branch, gitCommonDir }
  removeForkWorktree(workspace, path, branch)
  return null
}

export function removeForkWorktree(workspace: string, path: string, branch: string): void {
  gitOk(workspace, ["worktree", "remove", "--force", path])
  gitOk(workspace, ["branch", "-D", branch])
  rmSync(path, { recursive: true, force: true })
}

export function worktreeExists(path: string): boolean { return existsSync(path) }
