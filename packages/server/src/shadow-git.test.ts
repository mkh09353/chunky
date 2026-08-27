import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { spawnSync } from "node:child_process"
import { snapshotWorkspace, snapshotWorkspaceAsync, restoreSnapshot } from "./shadow-git.ts"
import { repoId } from "./repos.ts"

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

test("shadow snapshot round-trips files without using the workspace git directory", () => {
  const workspace = Bun.fileURLToPath(import.meta.url) // ensure a unique nearby temp dir isn't needed by git
  const dir = join(tmpdir(), `chunky-shadow-test-${crypto.randomUUID()}`)
  dirs.push(dir)
  mkdirSync(join(dir, ".git"), { recursive: true })
  writeFileSync(join(dir, ".git", "user-only"), "untouched")
  writeFileSync(join(dir, "kept.txt"), "before")
  writeFileSync(join(dir, "deleted.txt"), "delete me")
  const commit = snapshotWorkspace(dir, "refs/sessions/test")
  expect(commit).toBeString()
  writeFileSync(join(dir, "kept.txt"), "after")
  rmSync(join(dir, "deleted.txt"))
  writeFileSync(join(dir, "new.txt"), "new")
  expect(restoreSnapshot(dir, commit!)).toBe(true)
  expect(readFileSync(join(dir, "kept.txt"), "utf8")).toBe("before")
  expect(readFileSync(join(dir, "deleted.txt"), "utf8")).toBe("delete me")
  expect(existsSync(join(dir, "new.txt"))).toBe(false)
  expect(readFileSync(join(dir, ".git", "user-only"), "utf8")).toBe("untouched")
})

test("async shadow snapshots serialize safely and produce usable commits", async () => {
  const dir = join(tmpdir(), `chunky-shadow-test-${crypto.randomUUID()}`)
  dirs.push(dir)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "kept.txt"), "before")
  const [first, second] = await Promise.all([
    snapshotWorkspaceAsync(dir, "refs/sessions/first"),
    snapshotWorkspaceAsync(dir, "refs/sessions/second"),
  ])
  expect(first).toBeString()
  expect(second).toBeString()
  writeFileSync(join(dir, "kept.txt"), "after")
  expect(restoreSnapshot(dir, first!)).toBe(true)
  expect(readFileSync(join(dir, "kept.txt"), "utf8")).toBe("before")
})

test("snapshots exclude a nested Chunky home across repeated snapshots", () => {
  const workspace = join(tmpdir(), `chunky-shadow-home-${crypto.randomUUID()}`)
  const home = join(workspace, "internal-state")
  dirs.push(workspace)
  mkdirSync(join(home, "state", "archive"), { recursive: true })
  writeFileSync(join(home, "state", "archive", "secret.json"), "must not be captured")
  writeFileSync(join(workspace, "kept.txt"), "before")
  const previousHome = process.env.CHUNKY_HOME
  process.env.CHUNKY_HOME = home
  try {
    const first = snapshotWorkspace(workspace, "refs/sessions/first")
    expect(first).toBeString()
    writeFileSync(join(workspace, "kept.txt"), "second")
    const second = snapshotWorkspace(workspace, "refs/sessions/second")
    expect(second).toBeString()

    const shadow = join(home, "state", "shadow", repoId(realpathSync(workspace)))
    for (const commit of [first!, second!]) {
      const listed = spawnSync("git", ["--git-dir", shadow, "ls-tree", "-r", "--name-only", commit], { encoding: "utf8" })
      expect(listed.status).toBe(0)
      expect(listed.stdout).not.toContain("internal-state/")
      expect(listed.stdout).toContain("kept.txt")
    }

    writeFileSync(join(workspace, "kept.txt"), "changed")
    expect(restoreSnapshot(workspace, first!)).toBe(true)
    expect(readFileSync(join(workspace, "kept.txt"), "utf8")).toBe("before")
    expect(readFileSync(join(home, "state", "archive", "secret.json"), "utf8")).toBe("must not be captured")
  } finally {
    if (previousHome === undefined) delete process.env.CHUNKY_HOME
    else process.env.CHUNKY_HOME = previousHome
  }
})
