import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { createForkWorktree } from "./worktree-fork.ts"
import { repoId } from "./repos.ts"

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const git = (cwd: string, args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" })

test("failed worktree snapshot restore removes worktree and branch", () => {
  const root = mkdtempSync(join(tmpdir(), "chunky-worktree-")); dirs.push(root)
  const repo = join(root, "repo"), home = join(root, "home"); process.env.CHUNKY_HOME = home
  rmSync(repo, { force: true }); mkdirSync(repo)
  git(repo, ["init"]); git(repo, ["config", "user.email", "test@example.com"]); git(repo, ["config", "user.name", "Test"])
  writeFileSync(join(repo, "file"), "base"); git(repo, ["add", "."]); git(repo, ["commit", "-m", "base"])
  const id = "12345678-aaaa"
  expect(createForkWorktree(repo, id, () => false)).toBeNull()
  const branch = `chunky/repo-${id.slice(0, 8)}`
  expect(git(repo, ["show-ref", "--verify", `refs/heads/${branch}`]).status).not.toBe(0)
  expect(existsSync(join(home, "state", "worktrees", repoId(repo), "repo-12345678"))).toBe(false)
  delete process.env.CHUNKY_HOME
})
