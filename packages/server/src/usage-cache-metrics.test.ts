import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

async function runChild(mode: "migration" | "fresh"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `chunky-cache-metrics-${mode}-`))
  const proc = Bun.spawn([process.execPath, "run", "packages/server/src/usage-cache-metrics-child.ts"], {
    cwd: process.cwd(), env: { ...process.env, CHUNKY_DB: join(dir, "store.db"), CACHE_METRICS_MODE: mode }, stdout: "pipe", stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  expect(exitCode, `${stdout}\n${stderr}`).toBe(0)
  return stdout
}

test("usage_log cache metadata migrates additively", async () => {
  expect(await runChild("migration")).toContain("cache metrics migration: ok")
})

test("cache metadata round-trips and session metrics use weighted token sums", async () => {
  expect(await runChild("fresh")).toContain("cache metrics fresh: ok")
})
