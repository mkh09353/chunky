import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

test("usageBreakdown splits score by default sidekick vs named seats", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chunky-usage-breakdown-score-seat-"))
  const proc = Bun.spawn([process.execPath, "run", "packages/server/src/usage-breakdown-score-seat-child.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CHUNKY_DB: join(dir, "store.db"),
      CHUNKY_MODELS_CACHE: join(dir, "missing-models.json"),
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  expect(exitCode, `${stdout}\n${stderr}`).toBe(0)
  expect(stdout).toContain("usage breakdown scoreBySeat: default collapsed, named seats split, model score unchanged")
})
