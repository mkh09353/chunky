// Shared lifecycle owner for HTTP integration tests that boot index.ts.
// This is test-only: CHUNKY_TEST_PARENT_PID opts a child into parent-death polling.
import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const INHERITED_SERVER_IDENTITY = [
  "CHUNKY_SERVER_NONCE",
  "CHUNKY_SERVER_ID",
  "CHUNKY_DISCOVERY_RECORD",
  "CHUNKY_BUILD_ID",
  "CHUNKY_VERSION",
] as const

export interface IntegrationServerOptions {
  prefix: string
  root?: string
  port?: number
  cwd?: string
  env?: NodeJS.ProcessEnv
  /** Explicit launcher identity for ownership/drain tests. Inherited identity
   *  is always scrubbed; only these values are restored. */
  managedIdentity?: Partial<Record<(typeof INHERITED_SERVER_IDENTITY)[number], string>>
}

export interface IntegrationServer {
  root: string
  port: number
  baseUrl: string
  proc: Bun.Subprocess
  stop(): Promise<void>
}

export interface ReservedIntegrationServer {
  root: string
  port: number
  baseUrl: string
  proc: Bun.Subprocess | undefined
  start(): Promise<Bun.Subprocess>
  stop(): Promise<void>
}

export function integrationServerEnvironment(options: IntegrationServerOptions, root: string, port: number): Record<string, string | undefined> {
  const supplied = { ...(options.env ?? process.env) } as Record<string, string | undefined>
  const env: Record<string, string | undefined> = { ...supplied }
  for (const key of INHERITED_SERVER_IDENTITY) delete env[key]
  const isolated: Record<string, string | undefined> = {
    ...env,
    CHUNKY_PORT: String(port),
    CHUNKY_SETTINGS: join(root, "settings.json"),
    CHUNKY_AUTH: join(root, "auth.json"),
    CHUNKY_DB: join(root, "chunky.db"),
    CHUNKY_GRAPH_DB: join(root, "chunky-graph.db"),
    CHUNKY_WORKSPACE: root,
    CHUNKY_MODELS_CACHE: join(root, "missing-models.json"),
    CHUNKY_RELAY: "0",
    CHUNKY_TEST_PARENT_PID: String(process.pid),
  }
  // Custom test configuration (relay URLs, auth files, model fixtures) wins,
  // except launcher identity is always scrubbed from the inherited process.
  for (const [key, value] of Object.entries(supplied)) {
    if ((INHERITED_SERVER_IDENTITY as readonly string[]).includes(key)) continue
    isolated[key] = value
  }
  for (const [key, value] of Object.entries(options.managedIdentity ?? {})) isolated[key] = value
  // Test ownership always wins over inherited Chunky launcher/server state.
  // Callers may supply fixture-specific variables, but cannot accidentally
  // point the child back at the installed server's port, DB, or settings.
  isolated.CHUNKY_PORT = String(port)
  isolated.CHUNKY_SETTINGS = join(root, "settings.json")
  isolated.CHUNKY_AUTH = join(root, "auth.json")
  isolated.CHUNKY_DB = join(root, "chunky.db")
  isolated.CHUNKY_GRAPH_DB = join(root, "chunky-graph.db")
  isolated.CHUNKY_MODELS_CACHE = join(root, "missing-models.json")
  isolated.CHUNKY_RELAY = "0"
  isolated.CHUNKY_TEST_PARENT_PID = String(process.pid)
  return isolated
}

function freePort(): number {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() { return undefined } } })
  const port = listener.port
  listener.stop()
  return port
}

export function reserveIntegrationServer(options: IntegrationServerOptions): ReservedIntegrationServer {
  const root = options.root ?? mkdtempSync(join(tmpdir(), options.prefix))
  mkdirSync(root, { recursive: true })
  const port = options.port ?? freePort()
  let proc: Bun.Subprocess | undefined
  let stopped = false
  const start = async () => {
    if (proc) return proc
    proc = Bun.spawn([process.execPath, "run", "packages/server/src/index.ts"], {
      cwd: options.cwd ?? join(import.meta.dir, "../../.."),
      env: integrationServerEnvironment(options, root, port),
      stdout: "ignore", stderr: "ignore",
    })
    let lastError: unknown
    for (let attempt = 0; attempt < 200; attempt++) {
      if (proc.exitCode !== null) throw new Error(`integration server exited before becoming ready (${proc.exitCode})`)
      try {
        await fetch(`http://127.0.0.1:${port}/api/info`)
        return proc
      } catch (error) {
        lastError = error
        await Bun.sleep(25)
      }
    }
    throw new Error(`integration server did not become ready: ${lastError}`)
  }
  const stop = async () => {
    if (stopped) return
    stopped = true
    if (proc && proc.exitCode == null) {
      try { proc.kill("SIGTERM") } catch {}
      const exited = await Promise.race([proc.exited, Bun.sleep(2_000).then(() => null)])
      if (exited === null && proc.exitCode == null) {
        try { proc.kill("SIGKILL") } catch {}
        await proc.exited
      }
      await proc.exited
    }
    rmSync(root, { recursive: true, force: true })
  }
  return { root, port, baseUrl: `http://127.0.0.1:${port}`, get proc() { return proc }, start, stop }
}
