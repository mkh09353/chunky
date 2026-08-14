import { test, expect } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

test("Store usage/delegation smoke test uses an isolated sqlite database", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chunky-store-test-"))
  const dbPath = join(dir, "store.db")
  const proc = Bun.spawn([process.execPath, "run", "packages/server/src/store-smoke-child.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, CHUNKY_DB: dbPath },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  expect(exitCode, `${stdout}\n${stderr}`).toBe(0)
  expect(stdout).toContain("store smoke: delegation lifecycle")
})

test("repository-less sessions persist null workspace and list by explicit scope", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chunky-store-repoless-test-"))
  const dbPath = join(dir, "store.db")
  const proc = Bun.spawn([process.execPath, "run", "packages/server/src/store-repoless-child.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, CHUNKY_DB: dbPath },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  expect(exitCode, `${stdout}\n${stderr}`).toBe(0)
  expect(stdout).toContain("repo-less store smoke: ok")
})

test("delegation aliases resolve at insert and migrate in an isolated sqlite database", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chunky-store-alias-test-"))
  const dbPath = join(dir, "store.db")
  const proc = Bun.spawn([process.execPath, "run", "packages/server/src/store-alias-child.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, CHUNKY_DB: dbPath, CHUNKY_MODELS_CACHE: join(dir, "missing-models.json") },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  expect(exitCode, `${stdout}\n${stderr}`).toBe(0)
  expect(stdout).toContain("store alias")
})
