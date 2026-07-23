import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { snapshotWorkspace, snapshotWorkspaceAsync, restoreSnapshot } from "./shadow-git.ts"

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
