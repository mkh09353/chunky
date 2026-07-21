import { createHash, randomUUID } from "node:crypto"
import {
  mkdirSync,
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { join, resolve } from "node:path"
export const SERVER_IDENTITY_PATH = "/_chunky/server-identity"
export const SERVER_LEASES_PATH = "/_chunky/server-leases"

export interface LauncherServerIdentity {
  workspace: string
  version: string
  buildId: string
  nonce: string
  port: number
  /** Launcher ownership uuid, present for managed servers. */
  id?: string
}

export interface LauncherServerRecord extends LauncherServerIdentity {
  schema: 1
  id: string
  pid: number
  startedAt: number
}

export interface LauncherServerConfig {
  stateDir: string
  workspace: string
  version: string
  buildId: string
  startupTimeoutMs?: number
  pollIntervalMs?: number
  staleLockMs?: number
}

export interface LauncherServerStartDependencies {
  allocatePort(): Promise<number>
  startServer(identity: LauncherServerIdentity): Promise<{ pid: number; stop(): void }>
  stopPid?(pid: number): void
}

interface LauncherServerRuntimeDependencies {
  fetchIdentity(port: number): Promise<LauncherServerIdentity | null>
  sleep(ms: number): Promise<void>
  now(): number
  beforeStaleLockQuarantine?(observedToken: string): Promise<void>
  beforeLockReleaseQuarantine?(ownedToken: string): Promise<void>
}

const defaultDependencies: LauncherServerRuntimeDependencies = {
  async fetchIdentity(port) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}${SERVER_IDENTITY_PATH}`, {
        signal: AbortSignal.timeout(2_000),
      })
      if (!response.ok) return null
      return await response.json() as LauncherServerIdentity
    } catch {
      return null
    }
  },
  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  },
  now() {
    return Date.now()
  },
}

interface LockOwner {
  token: string
  pid: number
  createdAt: number
}

interface LockObservation {
  token: string | null
  createdAt: number
  inode: number
}

export class ServerLeaseTracker {
  private readonly leases = new Map<string, number>()
  private idleSince: number

  constructor(
    private readonly now: () => number,
    private readonly leaseTimeoutMs: number,
    private readonly idleGraceMs: number,
  ) {
    this.idleSince = now()
  }

  attach(token: string): void {
    this.leases.set(token, this.now())
  }

  release(token: string): void {
    this.leases.delete(token)
    if (this.leases.size === 0) this.idleSince = this.now()
  }

  /** Drop crashed launchers and report whether the server is safely idle. */
  shouldRetire(): boolean {
    const now = this.now()
    const hadLeases = this.leases.size > 0
    for (const [token, refreshedAt] of this.leases) {
      if (now - refreshedAt > this.leaseTimeoutMs) this.leases.delete(token)
    }
    if (this.leases.size > 0) return false
    if (hadLeases) {
      this.idleSince = now
      return false
    }
    return now - this.idleSince >= this.idleGraceMs
  }

  get size(): number {
    return this.leases.size
  }
}

export async function updateServerLease(port: number, token: string, action: "attach" | "release", serverToken: string): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${port}${SERVER_LEASES_PATH}`, {
    method: action === "attach" ? "POST" : "DELETE",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${serverToken}`,
    },
    body: JSON.stringify({ token }),
    signal: AbortSignal.timeout(1_000),
  })
  if (!response.ok) throw new Error(`Chunky server lease ${action} failed (${response.status})`)
}

export function removeDiscoveryRecordIfOwned(path: string, nonce: string): boolean {
  const record = readRecord(path)
  if (!record || record.id !== nonce) return false
  rmSync(path, { force: true })
  return true
}

/** Watch the registration so a superseded server retires itself. */
export function startOwnershipPoller(path: string, id: string, onLost: () => void, intervalMs = 10_000): () => void {
  let stopped = false
  const timer = setInterval(() => {
    if (stopped) return
    const record = readRecord(path)
    if (!record || record.id !== id) {
      stopped = true
      clearInterval(timer)
      onLost()
    }
  }, intervalMs)
  timer.unref?.()
  return () => { stopped = true; clearInterval(timer) }
}

/** Resolve symlinks and path aliases so two shells naming one directory share a server. */
export function canonicalWorkspace(path: string): string {
  const absolute = resolve(path)
  try {
    return realpathSync.native(absolute)
  } catch {
    return absolute
  }
}

/** Stable, filesystem-safe identity for the workspace/version server boundary. */
export function serverIdentityKey(workspace: string, version: string, buildId: string): string {
  return createHash("sha256")
    .update(`${canonicalWorkspace(workspace)}\0${version}\0${buildId}`)
    .digest("hex")
    .slice(0, 24)
}

/**
 * Identify the actual installed sources, not only package.json's version. Local
 * checkouts and older installs can legitimately carry different code under the
 * same prerelease version.
 */
export function computeAppBuildId(appRoot: string): string {
  const files = ["chunky.ts", "package.json", "bun.lock"]
  const sourceRoots = [
    "packages/protocol/src",
    "packages/server/src",
    "packages/tui/src",
  ]
  for (const sourceRoot of sourceRoots) {
    const absoluteRoot = join(appRoot, sourceRoot)
    if (!existsSync(absoluteRoot)) continue
    const visit = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const absolute = join(directory, entry.name)
        if (entry.isDirectory()) visit(absolute)
        else if (!/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name) && !entry.name.endsWith(".manual.ts")) {
          files.push(absolute.slice(appRoot.length + 1))
        }
      }
    }
    visit(absoluteRoot)
  }

  const hash = createHash("sha256")
  for (const relative of [...new Set(files)].sort()) {
    const absolute = join(appRoot, relative)
    if (!existsSync(absolute)) continue
    hash.update(relative).update("\0").update(readFileSync(absolute)).update("\0")
  }
  return hash.digest("hex").slice(0, 24)
}

function isRecord(value: unknown): value is LauncherServerRecord {
  if (!value || typeof value !== "object") return false
  const record = value as Partial<LauncherServerRecord>
  return record.schema === 1
    && typeof record.id === "string" && record.id.length > 0
    && typeof record.workspace === "string"
    && typeof record.version === "string"
    && typeof record.buildId === "string"
    && typeof record.nonce === "string"
    && Number.isInteger(record.port) && (record.port ?? 0) > 0
    && Number.isInteger(record.pid) && (record.pid ?? 0) > 0
    && typeof record.startedAt === "number"
}

function readRecord(path: string): LauncherServerRecord | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function writeRecord(path: string, record: LauncherServerRecord): void {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  writeFileSync(temporary, JSON.stringify(record, null, 2), { mode: 0o600 })
  renameSync(temporary, path)
}

function sameIdentity(record: LauncherServerRecord, identity: LauncherServerIdentity): boolean {
  return identity.workspace === record.workspace
    && identity.version === record.version
    && identity.buildId === record.buildId
    && identity.nonce === record.nonce
    && identity.port === record.port
    && identity.id === record.id
}

async function healthyRecord(
  recordPath: string,
  workspace: string,
  version: string,
  buildId: string,
  fetchIdentity: LauncherServerRuntimeDependencies["fetchIdentity"],
): Promise<LauncherServerRecord | null> {
  const record = readRecord(recordPath)
  if (!record || record.workspace !== workspace || record.version !== version || record.buildId !== buildId) return null
  const identity = await fetchIdentity(record.port)
  return identity && sameIdentity(record, identity) ? record : null
}

async function pruneStaleRecords(
  serversDir: string,
  workspace: string,
  fetchIdentity: LauncherServerRuntimeDependencies["fetchIdentity"],
): Promise<void> {
  for (const entry of readdirSync(serversDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue
    const path = join(serversDir, entry.name)
    const record = readRecord(path)
    if (!record) {
      // Legacy/malformed records are stale. Remove only records that advertise
      // this workspace; records for other workspaces are not ours to touch.
      try {
        const raw = JSON.parse(readFileSync(path, "utf8")) as { workspace?: unknown }
        if (raw.workspace === workspace) rmSync(path, { force: true })
      } catch {}
      continue
    }
    if (record.workspace !== workspace) continue
    const identity = await fetchIdentity(record.port)
    if (!identity || !sameIdentity(record, identity)) rmSync(path, { force: true })
  }
}

function lockOwner(lockPath: string): LockOwner | null {
  try {
    const value = JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8")) as Partial<LockOwner>
    return typeof value.token === "string" && typeof value.pid === "number" && typeof value.createdAt === "number"
      ? value as LockOwner
      : null
  } catch {
    return null
  }
}

function createLock(lockPath: string, now: number): string | null {
  const token = randomUUID()
  try {
    mkdirSync(lockPath)
    writeFileSync(join(lockPath, "owner.json"), JSON.stringify({ token, pid: process.pid, createdAt: now }), { mode: 0o600 })
    return token
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return null
    rmSync(lockPath, { recursive: true, force: true })
    throw error
  }
}

function ownsLock(lockPath: string, token: string): boolean {
  return lockOwner(lockPath)?.token === token
}

function observeLock(lockPath: string): LockObservation | null {
  try {
    const stat = statSync(lockPath)
    const owner = lockOwner(lockPath)
    return {
      token: owner?.token ?? null,
      createdAt: owner?.createdAt ?? stat.mtimeMs,
      inode: stat.ino,
    }
  } catch {
    return null
  }
}

function restoreQuarantine(quarantine: string, lockPath: string): void {
  try {
    if (!existsSync(lockPath)) renameSync(quarantine, lockPath)
    else rmSync(quarantine, { recursive: true, force: true })
  } catch {}
}

async function acquireLock(
  lockPath: string,
  now: number,
  staleLockMs: number,
  beforeQuarantine?: (observedToken: string) => Promise<void>,
): Promise<string | null> {
  const created = createLock(lockPath, now)
  if (created) return created

  const observed = observeLock(lockPath)
  if (!observed || now - observed.createdAt <= staleLockMs) return null
  await beforeQuarantine?.(observed.token ?? "<ownerless>")

  // Rename first, then inspect the moved owner. If another contender replaced
  // the path since our read, we quarantined its fresh lock: restore it and do
  // not claim ownership. This fences stale-lock TOCTOU races.
  const quarantine = `${lockPath}.stale-${randomUUID()}`
  try {
    renameSync(lockPath, quarantine)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    return null
  }
  const moved = observeLock(quarantine)
  if (!moved || moved.inode !== observed.inode || moved.token !== observed.token) {
    restoreQuarantine(quarantine, lockPath)
    return null
  }
  rmSync(quarantine, { recursive: true, force: true })
  return createLock(lockPath, now)
}

async function releaseLock(
  lockPath: string,
  token: string,
  beforeQuarantine?: (ownedToken: string) => Promise<void>,
): Promise<void> {
  if (!ownsLock(lockPath, token)) return
  await beforeQuarantine?.(token)
  const quarantine = `${lockPath}.release-${randomUUID()}`
  try {
    renameSync(lockPath, quarantine)
  } catch {
    return
  }
  if (lockOwner(quarantine)?.token === token) {
    rmSync(quarantine, { recursive: true, force: true })
  } else {
    restoreQuarantine(quarantine, lockPath)
  }
}

/**
 * Reuse or atomically create the server for a canonical workspace/app version.
 * The startup directory is the lock, so concurrent launchers cannot both spawn.
 */
export async function ensureWorkspaceServer(
  config: LauncherServerConfig,
  dependencies: LauncherServerStartDependencies & Partial<LauncherServerRuntimeDependencies>,
): Promise<{ record: LauncherServerRecord; started: boolean }> {
  const deps = { ...defaultDependencies, ...dependencies }
  const workspace = canonicalWorkspace(config.workspace)
  const key = serverIdentityKey(workspace, config.version, config.buildId)
  const serversDir = join(config.stateDir, "servers")
  const recordPath = join(serversDir, `${key}.json`)
  const lockPath = join(serversDir, `${key}.lock`)
  const startupTimeoutMs = config.startupTimeoutMs ?? 15_000
  const pollIntervalMs = config.pollIntervalMs ?? 100
  const staleLockMs = config.staleLockMs ?? startupTimeoutMs + 5_000
  const deadline = deps.now() + startupTimeoutMs
  mkdirSync(serversDir, { recursive: true })
  await pruneStaleRecords(serversDir, workspace, deps.fetchIdentity)

  while (deps.now() <= deadline) {
    const existing = await healthyRecord(recordPath, workspace, config.version, config.buildId, deps.fetchIdentity)
    if (existing) return { record: existing, started: false }

    const lockToken = await acquireLock(lockPath, deps.now(), staleLockMs, deps.beforeStaleLockQuarantine)
    if (!lockToken) {
      await deps.sleep(pollIntervalMs)
      continue
    }

    try {
      // A prior lock owner may have completed between our health check and mkdir.
      const raced = await healthyRecord(recordPath, workspace, config.version, config.buildId, deps.fetchIdentity)
      if (raced) return { record: raced, started: false }
      if (!ownsLock(lockPath, lockToken)) continue

      // A matching record that failed health/version checks owns a process we
      // should retire before replacing. Missing/legacy records are simply stale.
      const stale = readRecord(recordPath)
      if (stale) {
        deps.stopPid?.(stale.pid)
        rmSync(recordPath, { force: true })
      }

      const identity: LauncherServerIdentity = {
        workspace,
        version: config.version,
        buildId: config.buildId,
        nonce: randomUUID(),
        port: await deps.allocatePort(),
        id: randomUUID(),
      }
      if (!ownsLock(lockPath, lockToken)) continue
      const child = await deps.startServer(identity)
      const record: LauncherServerRecord = {
        schema: 1,
        id: identity.id!,
        ...identity,
        pid: child.pid,
        startedAt: deps.now(),
      }
      try {
        while (deps.now() <= deadline) {
          const live = await deps.fetchIdentity(record.port)
          if (live && sameIdentity(record, live)) {
            if (!ownsLock(lockPath, lockToken)) throw new Error("lost Chunky server startup lock")
            writeRecord(recordPath, record)
            return { record, started: true }
          }
          await deps.sleep(pollIntervalMs)
        }
        throw new Error(`Chunky server did not become ready on port ${record.port}`)
      } catch (error) {
        child.stop()
        rmSync(recordPath, { force: true })
        throw error
      }
    } finally {
      await releaseLock(lockPath, lockToken, deps.beforeLockReleaseQuarantine)
    }
  }

  throw new Error(`Timed out waiting for the Chunky server for ${workspace}`)
}
