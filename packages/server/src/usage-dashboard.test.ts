import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

test("usage dashboard store queries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chunky-usage-dashboard-test-"))
  const proc = Bun.spawn([process.execPath, "run", "packages/server/src/usage-dashboard-smoke-child.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CHUNKY_DB: join(dir, "store.db"),
      // Pin an empty models.dev cache so gpt-4o uses the static MODEL_PRICING
      // table (2.5/10/1.25). A live cache first-wins Cortecs' gpt-4o card and
      // inflates estimatedApiCost (4.125 → 4.3875) without any alias rewrite.
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
  expect(stdout).toContain("usage dashboard smoke")
})
