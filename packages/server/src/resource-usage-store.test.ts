import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

async function runChild(mode: "migration" | "fresh"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `chunky-resource-store-${mode}-`))
  const proc = Bun.spawn([process.execPath, "run", "packages/server/src/resource-usage-store-child.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, CHUNKY_DB: join(dir, "store.db"), RESOURCE_STORE_MODE: mode, CHUNKY_MODELS_CACHE: join(dir, "missing-models.json") },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  expect(exitCode, `${stdout}\n${stderr}`).toBe(0)
  return stdout
}

test("resource_samples migrates additively and stays idempotent", async () => {
  expect(await runChild("migration")).toContain("resource store migration: ok")
})

test("resource_samples round-trips and prunes rows older than 14 days", async () => {
  expect(await runChild("fresh")).toContain("resource store fresh: ok")
})
