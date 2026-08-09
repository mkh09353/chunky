import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

test("usage dashboard store queries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chunky-usage-dashboard-test-"))
  const proc = Bun.spawn([process.execPath, "run", "packages/server/src/usage-dashboard-smoke-child.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, CHUNKY_DB: join(dir, "store.db") },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  expect(exitCode, `${stdout}\n${stderr}`).toBe(0)
  expect(stdout).toContain("usage dashboard smoke")
})
