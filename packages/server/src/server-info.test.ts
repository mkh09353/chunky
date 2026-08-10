import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const root = mkdtempSync(join(tmpdir(), "chunky-server-info-"))
const workspace = realpathSync(root)
const repoRoot = join(import.meta.dir, "../../..")
const packageVersion = (JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { version: string }).version
const processes: Bun.Subprocess[] = []

function freePort(): number {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() { return undefined } } })
  const port = listener.port
  listener.stop()
  return port
}

function startServer(name: string, identity?: { version: string; buildId: string }): { baseUrl: string; token: string } {
  const state = join(root, name)
  const token = `${name}-token`
  const port = freePort()
  writeFileSync(join(root, `${name}-settings.json`), JSON.stringify({ serverToken: token }))
  const env = { ...process.env }
  for (const key of ["CHUNKY_SERVER_NONCE", "CHUNKY_SERVER_ID", "CHUNKY_BUILD_ID", "CHUNKY_VERSION"]) delete env[key]
  if (identity) {
    env.CHUNKY_SERVER_NONCE = `${name}-nonce`
    env.CHUNKY_SERVER_ID = `${name}-id`
    env.CHUNKY_BUILD_ID = identity.buildId
    env.CHUNKY_VERSION = identity.version
  }
  const proc = Bun.spawn([process.execPath, "run", "packages/server/src/index.ts"], {
    cwd: repoRoot,
    env: {
      ...env,
      CHUNKY_PORT: String(port),
      CHUNKY_SETTINGS: join(root, `${name}-settings.json`),
      CHUNKY_DB: `${state}.db`,
      CHUNKY_GRAPH_DB: `${state}-graph.db`,
      CHUNKY_RELAY: "0",
      CHUNKY_WORKSPACE: root,
    },
    stdout: "ignore",
    stderr: "ignore",
  })
  processes.push(proc)
  return { baseUrl: `http://127.0.0.1:${port}`, token }
}

async function info(server: { baseUrl: string; token: string }): Promise<Response> {
  let last: unknown
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      return await fetch(`${server.baseUrl}/api/info`, {
        headers: { Authorization: `Bearer ${server.token}` },
      })
    } catch (error) {
      last = error
      await Bun.sleep(25)
    }
  }
  throw last
}

afterAll(async () => {
  for (const proc of processes) proc.kill("SIGTERM")
  await Promise.all(processes.map((proc) => proc.exited))
  rmSync(root, { recursive: true, force: true })
})

describe("GET /api/info server identity", () => {
  test("reports launcher identity for a managed server", async () => {
    const response = await info(startServer("managed", { version: "9.8.7", buildId: "managed-build" }))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      workspace,
      version: "9.8.7",
      buildId: "managed-build",
      channel: "managed",
    })
  })

  test("reports the package version and dev channel without launcher identity", async () => {
    const response = await info(startServer("dev"))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      workspace,
      version: packageVersion,
      channel: "dev",
    })
  })
})
