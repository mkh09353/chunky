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
