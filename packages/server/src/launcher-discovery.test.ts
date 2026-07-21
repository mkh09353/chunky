import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  SERVER_IDENTITY_PATH,
  ServerLeaseTracker,
  canonicalWorkspace,
  computeAppBuildId,
  ensureWorkspaceServer,
  serverIdentityKey,
  updateServerLease,
  type LauncherServerIdentity,
} from "./launcher-discovery.ts"

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "chunky-launcher-"))
  dirs.push(dir)
  return dir
}

function harness(stateDir: string) {
  const live = new Map<number, LauncherServerIdentity>()
  let starts = 0
  let nextPort = 5100
  return {
    live,
    get starts() { return starts },
    deps: {
      allocatePort: async () => nextPort++,
      startServer: async (identity: LauncherServerIdentity) => {
        starts++
        live.set(identity.port, identity)
        return {
          pid: 9000 + starts,
          stop: () => { live.delete(identity.port) },
        }
      },
      fetchIdentity: async (port: number) => live.get(port) ?? null,
      sleep: async () => {},
      now: () => Date.now(),
    },
    config: {
      stateDir,
      workspace: "/tmp/project",
      version: "1.2.3",
      buildId: "build-one",
      startupTimeoutMs: 1_000,
      pollIntervalMs: 1,
      staleLockMs: 5_000,
    },
  }
}

describe("launcher server discovery", () => {
  test("authenticates lease updates with the launcher's state token", async () => {
    const originalFetch = globalThis.fetch
    const authorizations: Array<string | null> = []
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      authorizations.push(new Headers(init?.headers).get("authorization"))
      return new Response(JSON.stringify({ leases: 1 }), { status: 200 })
    }) as typeof fetch

    try {
      await updateServerLease(5100, "lease-token", "attach", "state-token")
    } finally {
      globalThis.fetch = originalFetch
    }

    expect(authorizations).toEqual(["Bearer state-token"])
  })

  test("uses one server for concurrent launchers with the same workspace and version", async () => {
    const h = harness(tempDir())
    const [first, second] = await Promise.all([
      ensureWorkspaceServer(h.config, h.deps),
      ensureWorkspaceServer(h.config, h.deps),
    ])

    expect(h.starts).toBe(1)
    expect(first.record.port).toBe(second.record.port)
    expect([first.started, second.started].sort()).toEqual([false, true])
  })

  test("reuses a healthy record and replaces a stale one", async () => {
    const h = harness(tempDir())
    const first = await ensureWorkspaceServer(h.config, h.deps)
    const reused = await ensureWorkspaceServer(h.config, h.deps)
    h.live.delete(first.record.port)
    const replacement = await ensureWorkspaceServer(h.config, h.deps)

    expect(reused.started).toBe(false)
    expect(reused.record.port).toBe(first.record.port)
    expect(replacement.started).toBe(true)
    expect(replacement.record.port).not.toBe(first.record.port)
    expect(h.starts).toBe(2)
  })

  test("recovers an abandoned ownerless startup lock", async () => {
    const stateDir = tempDir()
    const h = harness(stateDir)
    const key = serverIdentityKey(h.config.workspace, h.config.version, h.config.buildId)
    const lock = join(stateDir, "servers", `${key}.lock`)
    mkdirSync(lock, { recursive: true })
    const old = new Date(Date.now() - 60_000)
    utimesSync(lock, old, old)

    const result = await ensureWorkspaceServer(h.config, h.deps)

    expect(result.started).toBe(true)
    expect(h.starts).toBe(1)
  })

  test("release never deletes a replacement lock", async () => {
    const stateDir = tempDir()
    const h = harness(stateDir)
    const key = serverIdentityKey(h.config.workspace, h.config.version, h.config.buildId)
    const lock = join(stateDir, "servers", `${key}.lock`)
    const replacement = { token: "replacement", pid: 456, createdAt: Date.now() }

    const result = await ensureWorkspaceServer(h.config, {
      ...h.deps,
      beforeLockReleaseQuarantine: async () => {
        rmSync(lock, { recursive: true, force: true })
        mkdirSync(lock)
        writeFileSync(join(lock, "owner.json"), JSON.stringify(replacement))
      },
    })

    expect(result.started).toBe(true)
    expect(JSON.parse(readFileSync(join(lock, "owner.json"), "utf8"))).toEqual(replacement)
  })

  test("fences two contenders racing to steal the same stale lock", async () => {
    const stateDir = tempDir()
    const h = harness(stateDir)
    const key = serverIdentityKey(h.config.workspace, h.config.version, h.config.buildId)
    const lock = join(stateDir, "servers", `${key}.lock`)
    mkdirSync(lock, { recursive: true })
    writeFileSync(join(lock, "owner.json"), JSON.stringify({
      token: "stale-owner",
      pid: 123,
      createdAt: Date.now() - 60_000,
    }))
    let arrivals = 0
    let release!: () => void
    const bothObserved = new Promise<void>((resolve) => { release = resolve })
    const beforeStaleLockQuarantine = async () => {
      arrivals++
      if (arrivals === 2) release()
      await bothObserved
    }

    const [first, second] = await Promise.all([
      ensureWorkspaceServer(h.config, { ...h.deps, beforeStaleLockQuarantine }),
      ensureWorkspaceServer(h.config, { ...h.deps, beforeStaleLockQuarantine }),
    ])

    expect(arrivals).toBe(2)
    expect(h.starts).toBe(1)
    expect(first.record.port).toBe(second.record.port)
  })

  test("does not trust a record for a mismatched server identity", async () => {
    const stateDir = tempDir()
    const h = harness(stateDir)
    const key = serverIdentityKey(h.config.workspace, h.config.version, h.config.buildId)
    const servers = join(stateDir, "servers")
    mkdirSync(servers, { recursive: true })
    writeFileSync(join(servers, `${key}.json`), JSON.stringify({
      schema: 1,
      workspace: h.config.workspace,
      version: h.config.version,
      buildId: h.config.buildId,
      nonce: "expected",
      port: 5099,
      pid: 1,
      startedAt: Date.now(),
    }))
    h.live.set(5099, {
      workspace: h.config.workspace,
      version: h.config.version,
      buildId: h.config.buildId,
      nonce: "different",
      port: 5099,
    })

    const result = await ensureWorkspaceServer(h.config, h.deps)

    expect(result.started).toBe(true)
    expect(result.record.port).not.toBe(5099)
  })

  test("prunes a crashed superseded-build record without touching live servers", async () => {
    const stateDir = tempDir()
    const h = harness(stateDir)
    const servers = join(stateDir, "servers")
    mkdirSync(servers, { recursive: true })
    const oldKey = serverIdentityKey(h.config.workspace, h.config.version, "old-build")
    const oldPath = join(servers, `${oldKey}.json`)
    writeFileSync(oldPath, JSON.stringify({
      schema: 1,
      workspace: h.config.workspace,
      version: h.config.version,
      buildId: "old-build",
      nonce: "dead",
      port: 5088,
      pid: 88,
      startedAt: Date.now(),
    }))

    await ensureWorkspaceServer(h.config, h.deps)

    expect(existsSync(oldPath)).toBe(false)
  })

  test("keys discovery by canonical workspace and application version", () => {
    const root = tempDir()
    mkdirSync(join(root, "project"))
    const canonical = canonicalWorkspace(join(root, "project", "..", "project"))

    expect(canonical).toBe(canonicalWorkspace(join(root, "project")))
    expect(serverIdentityKey(canonical, "1.0.0", "build-a")).not.toBe(serverIdentityKey(canonical, "2.0.0", "build-a"))
    expect(serverIdentityKey(canonical, "1.0.0", "build-a")).not.toBe(serverIdentityKey(canonical, "1.0.0", "build-b"))
    expect(SERVER_IDENTITY_PATH).toBe("/_chunky/server-identity")
  })

  test("build identity changes when runtime source changes", () => {
    const app = tempDir()
    mkdirSync(join(app, "packages", "server", "src"), { recursive: true })
    writeFileSync(join(app, "chunky.ts"), "launcher one")
    writeFileSync(join(app, "package.json"), "{}")
    writeFileSync(join(app, "packages", "server", "src", "index.ts"), "server one")
    const first = computeAppBuildId(app)
    writeFileSync(join(app, "packages", "server", "src", "index.ts"), "server two")

    expect(computeAppBuildId(app)).not.toBe(first)
  })

  test("stops an unready child without publishing its discovery record", async () => {
    const stateDir = tempDir()
    let now = 0
    let stopped = false
    const config = {
      stateDir,
      workspace: "/tmp/project",
      version: "1.2.3",
      buildId: "failed-build",
      startupTimeoutMs: 2,
      pollIntervalMs: 1,
    }
    const key = serverIdentityKey(config.workspace, config.version, config.buildId)

    await expect(ensureWorkspaceServer(config, {
      allocatePort: async () => 5200,
      startServer: async () => ({ pid: 9999, stop: () => { stopped = true } }),
      fetchIdentity: async () => null,
      sleep: async (ms) => { now += ms },
      now: () => now,
    })).rejects.toThrow("did not become ready")

    expect(stopped).toBe(true)
    expect(existsSync(join(stateDir, "servers", `${key}.json`))).toBe(false)
  })

  test("retires only after every client lease is gone for the full grace period", () => {
    let now = 0
    const leases = new ServerLeaseTracker(() => now, 30, 20)
    leases.attach("one")
    leases.attach("two")
    now = 25
    leases.attach("one")
    leases.release("two")
    expect(leases.shouldRetire()).toBe(false)
    now = 40
    expect(leases.shouldRetire()).toBe(false)
    leases.release("one")
    now = 59
    expect(leases.shouldRetire()).toBe(false)
    now = 60
    expect(leases.shouldRetire()).toBe(true)
  })

  test("expired crashed-client leases still receive an idle grace period", () => {
    let now = 0
    const leases = new ServerLeaseTracker(() => now, 30, 20)
    leases.attach("crashed")
    now = 31
    expect(leases.shouldRetire()).toBe(false)
    now = 50
    expect(leases.shouldRetire()).toBe(false)
    now = 51
    expect(leases.shouldRetire()).toBe(true)
  })
})
