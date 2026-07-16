import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

const dir = mkdtempSync(join(tmpdir(), "chunky-zen-optional-"))
const entry = join(process.cwd(), "packages/server/src/providers/registry.ts")

afterAll(() => rmSync(dir, { recursive: true, force: true }))

async function probe(settings: object, expression: string): Promise<string> {
  const settingsPath = join(dir, `${Math.random().toString(36).slice(2)}.json`)
  writeFileSync(settingsPath, JSON.stringify(settings))
  const script = `
    const registry = await import(${JSON.stringify(entry)})
    const settings = await import(${JSON.stringify(join(process.cwd(), "packages/server/src/settings.ts"))})
    ${expression}
  `
  const proc = Bun.spawn([process.execPath, "-e", script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CHUNKY_SETTINGS: settingsPath,
      CHUNKY_AUTH: join(dir, "auth.json"),
      ZEN_API_KEY: "",
      ZEN_BASE_URL: "",
      ZEN_MODEL: "",
      CHUNKY_PROVIDER: "",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (exitCode !== 0) throw new Error(`probe failed (${exitCode}): ${stderr}`)
  return stdout.trim()
}

describe("Zen optional provider", () => {
  test("fresh empty settings do not default to Zen", async () => {
    const output = await probe({}, `console.log(registry.activeProviderId())`)
    expect(output).not.toBe("zen")
  })

  test("explicit persisted Zen remains active", async () => {
    const output = await probe({ provider: "zen" }, `console.log(registry.activeProviderId())`)
    expect(output).toBe("zen")
  })

  test("missing Zen environment makes discovery empty and not ready", async () => {
    const output = await probe({}, `
      const zen = registry.getProvider("zen")
      console.log(JSON.stringify({ ready: zen.ready(), models: await registry.listModelsFor("zen") }))
    `)
    expect(JSON.parse(output)).toEqual({ ready: false, models: [] })
  })
})
