import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { reserveIntegrationServer, type ReservedIntegrationServer } from "./test-server.ts"

const root = mkdtempSync(join(tmpdir(), "chunky-server-info-"))
const workspace = realpathSync(root)
const repoRoot = join(import.meta.dir, "../../..")
const packageVersion = (JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { version: string }).version
const processes: ReservedIntegrationServer[] = []

async function startServer(name: string, identity?: { version: string; buildId: string }): Promise<{ baseUrl: string; token: string }> {
  const token = `${name}-token`
  const state = join(root, name)
  mkdirSync(state)
  writeFileSync(join(state, "settings.json"), JSON.stringify({ serverToken: token }))
  const env = { ...process.env }
  if (identity) {
    env.CHUNKY_SERVER_NONCE = `${name}-nonce`
    env.CHUNKY_SERVER_ID = `${name}-id`
    env.CHUNKY_BUILD_ID = identity.buildId
    env.CHUNKY_VERSION = identity.version
  }
  const server = reserveIntegrationServer({
    prefix: `chunky-server-info-${name}-`,
    root: state,
    cwd: repoRoot,
    managedIdentity: identity ? {
      CHUNKY_SERVER_NONCE: `${name}-nonce`,
      CHUNKY_SERVER_ID: `${name}-id`,
      CHUNKY_BUILD_ID: identity.buildId,
      CHUNKY_VERSION: identity.version,
    } : undefined,
    env: { ...env, CHUNKY_SETTINGS: join(state, "settings.json"), CHUNKY_WORKSPACE: root },
  })
  processes.push(server)
  await server.start()
  return { baseUrl: server.baseUrl, token }
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
  await Promise.all(processes.map((server) => server.stop()))
  rmSync(root, { recursive: true, force: true })
})

describe("GET /api/info server identity", () => {
  test("reports launcher identity for a managed server", async () => {
    const response = await info(await startServer("managed", { version: "9.8.7", buildId: "managed-build" }))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      workspace,
      version: "9.8.7",
      buildId: "managed-build",
      channel: "managed",
    })
  }, 15_000)

  test("reports the package version and dev channel without launcher identity", async () => {
    const response = await info(await startServer("dev"))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      workspace,
      version: packageVersion,
      channel: "dev",
    })
  }, 15_000)
})
