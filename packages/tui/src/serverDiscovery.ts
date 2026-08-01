// Finding this workspace's server again after the one we were talking to went
// away.
//
// The TUI is started with a fixed CHUNKY_PORT, so without this it would retry a
// dead port forever when its server is replaced by a newer build (the launcher
// starts a successor and the old server drains — see the server's drain.ts).
// The launcher's discovery records are the map: read them, verify what is
// actually listening, and prefer a server that is not itself retiring.
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { canonicalWorkspace } from "../../server/src/launcher-discovery.ts"
import { stateDir } from "../../server/src/repos.ts"

export interface DiscoveredRecord {
  id: string
  workspace: string
  version: string
  port: number
  startedAt: number
}

export interface ServerProbe {
  /** Answering as the server the record describes. */
  ok: boolean
  /** Draining after being superseded — usable now, but not worth moving TO. */
  retiring: boolean
}

export interface DiscoveryDeps {
  readRecords(): DiscoveredRecord[]
  probe(port: number): Promise<ServerProbe>
}

/** Where the launcher writes its discovery records. */
export function serversDir(): string {
  return join(stateDir(), "servers")
}

function validRecord(value: unknown): value is DiscoveredRecord {
  if (!value || typeof value !== "object") return false
  const record = value as Partial<DiscoveredRecord>
  return typeof record.id === "string" && typeof record.workspace === "string"
    && typeof record.version === "string" && Number.isInteger(record.port) && (record.port ?? 0) > 0
}

export function readRecords(dir = serversDir()): DiscoveredRecord[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      if (!entry.isFile() || !entry.name.endsWith(".json")) return []
      try {
        const value: unknown = JSON.parse(readFileSync(join(dir, entry.name), "utf8"))
        if (!validRecord(value)) return []
        return [{ ...value, startedAt: typeof value.startedAt === "number" ? value.startedAt : 0 }]
      } catch { return [] }
    })
  } catch { return [] }
}

/**
 * Records that could serve this workspace, best first (newest wins). Pure, so
 * the ordering rule is testable without a filesystem or a server.
 */
export function orderCandidates(
  records: DiscoveredRecord[],
  workspace: string,
  excludePort?: number,
): DiscoveredRecord[] {
  const wanted = canonicalWorkspace(workspace)
  return records
    .filter((record) => canonicalWorkspace(record.workspace) === wanted && record.port !== excludePort)
    .sort((a, b) => b.startedAt - a.startedAt || b.port - a.port)
}

async function probeServer(port: number): Promise<ServerProbe> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/_chunky/server-identity`, {
      signal: AbortSignal.timeout(1_000),
    })
    if (!response.ok) return { ok: false, retiring: false }
    const identity = await response.json() as { port?: unknown; retiring?: unknown }
    return { ok: identity?.port === port, retiring: identity?.retiring === true }
  } catch {
    return { ok: false, retiring: false }
  }
}

const defaultDeps: DiscoveryDeps = { readRecords: () => readRecords(), probe: probeServer }

/** Has the server we are attached to announced that it is draining after being
 *  superseded? Advisory: anything unreadable counts as "no". */
export async function serverIsRetiring(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/_chunky/server-identity`, {
      signal: AbortSignal.timeout(1_000),
    })
    if (!response.ok) return false
    const identity = await response.json() as { retiring?: unknown }
    return identity?.retiring === true
  } catch {
    return false
  }
}

/**
 * The base URL of a live server for this workspace, or null when none is up
 * yet (the caller keeps backing off and asks again). A retiring server is only
 * chosen if nothing else is available — it is still serving, and staying with
 * it beats dropping the user's session entirely.
 */
export async function findWorkspaceServer(
  workspace: string,
  excludeBaseUrl?: string,
  deps: DiscoveryDeps = defaultDeps,
): Promise<string | null> {
  const excludePort = excludeBaseUrl ? Number(new URL(excludeBaseUrl).port) || undefined : undefined
  const candidates = orderCandidates(deps.readRecords(), workspace, excludePort)
  let fallback: number | null = null
  for (const candidate of candidates) {
    const probe = await deps.probe(candidate.port)
    if (!probe.ok) continue
    if (!probe.retiring) return `http://localhost:${candidate.port}`
    if (fallback === null) fallback = candidate.port
  }
  return fallback === null ? null : `http://localhost:${fallback}`
}
