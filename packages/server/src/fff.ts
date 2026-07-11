// Shared FFF (https://github.com/dmtrKovalenko/fff) FileFinder pool for the
// server. One long-lived index PER WORKSPACE powers agent tools (fffind/ffgrep)
// and the @-mention autocomplete (GET /api/files/search). Finders are lazily
// booted on first use for a workspace and kept hot (OpenCode's per-directory
// instance pattern), so sessions in different repos search concurrently.
import { mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { FileFinder } from "@ff-labs/fff-bun"
import { LAUNCH_WORKSPACE } from "./workspace.ts"

/** Stable slug for a base path (djb2 → base36, same scheme as repos.ts) so each
 *  workspace gets its own frecency/history DB directory. */
function baseSlug(path: string): string {
  let h = 5381
  for (let i = 0; i < path.length; i++) h = ((h << 5) + h + path.charCodeAt(i)) | 0
  return "b" + (h >>> 0).toString(36)
}

/** Where FFF keeps frecency + query-history DBs for `basePath`. Prefer the state
 *  dir next to settings.json (launcher sets CHUNKY_SETTINGS →
 *  ~/.chunky/state/settings.json), namespaced per workspace so finders never
 *  share native DB files. */
function fffStateDir(basePath: string): string {
  const settings = process.env.CHUNKY_SETTINGS
  if (settings) return join(dirname(settings), "fff", baseSlug(basePath))
  // Dev / tests without the launcher: keep DBs next to the workspace.
  return join(basePath, ".chunky-fff")
}

const finders = new Map<string, FileFinder>()
const pending = new Map<string, Promise<FileFinder>>()
// FFF's native DB creation is not safe to race — serialize ALL creates (even
// for different bases) through one chain; searches themselves run concurrently.
let createChain: Promise<unknown> = Promise.resolve()

/** Get (or lazily create) the FileFinder for one workspace. Concurrent callers
 *  for the same base share one in-flight create. */
export async function getFinder(basePath: string = LAUNCH_WORKSPACE): Promise<FileFinder> {
  const existing = finders.get(basePath)
  if (existing && !existing.isDestroyed) return existing

  const inFlight = pending.get(basePath)
  if (inFlight) return inFlight

  const create = createChain.then(async () => {
    const stateDir = fffStateDir(basePath)
    try {
      mkdirSync(stateDir, { recursive: true })
    } catch {
      // best-effort; FFF still works without persistent frecency
    }

    const result = FileFinder.create({
      basePath,
      frecencyDbPath: join(stateDir, "frecency.mdb"),
      historyDbPath: join(stateDir, "history.mdb"),
      aiMode: true,
      // basePath is the project root; never index $HOME or /.
      enableHomeDirScanning: false,
      enableFsRootScanning: false,
    })
    if (!result.ok) {
      throw new Error(`FFF init failed: ${result.error}`)
    }
    const finder = result.value
    finders.set(basePath, finder)
    // Cap wait so a huge repo doesn't block the first tool call forever.
    await finder.waitForScan(15_000)
    return finder
  })
  createChain = create.catch(() => {}) // a failed create must not wedge the chain
  pending.set(basePath, create)
  void create.finally(() => pending.delete(basePath)).catch(() => {})
  return create
}

/** Tear down all finders (tests / process shutdown). */
export function destroyFinder(): void {
  for (const finder of finders.values()) {
    if (!finder.isDestroyed) finder.destroy()
  }
  finders.clear()
  pending.clear()
}

/** Annotation suffix for git-dirty files (mirrors pi-fff). */
export function gitAnnotation(gitStatus: string | undefined): string {
  if (!gitStatus || gitStatus === "clean") return ""
  return ` [${gitStatus}]`
}

/** Build a query string from optional path constraint + pattern + excludes. */
export function buildFffQuery(
  pattern: string,
  pathConstraint?: string,
  exclude?: string | string[],
): string {
  const parts: string[] = []
  if (pathConstraint) {
    const c = normalizePathConstraint(pathConstraint)
    if (c) parts.push(c)
  }
  parts.push(...normalizeExcludes(exclude))
  if (pattern) parts.push(pattern)
  return parts.join(" ")
}

function normalizePathConstraint(pathConstraint: string): string | null {
  let trimmed = pathConstraint.trim()
  if (!trimmed) return trimmed
  if (trimmed === "." || trimmed === "./") return null
  if (trimmed.startsWith("./")) trimmed = trimmed.slice(2)
  // Bare dir → PathSegment constraint.
  if (
    !trimmed.startsWith("/") &&
    !trimmed.endsWith("/") &&
    !/[*?[{]/.test(trimmed) &&
    !/\.[a-zA-Z][a-zA-Z0-9]{0,9}$/.test(trimmed.split("/").pop() ?? "")
  ) {
    return `${trimmed}/`
  }
  return trimmed
}

function normalizeExcludes(exclude: string | string[] | undefined): string[] {
  if (!exclude) return []
  const list = Array.isArray(exclude) ? exclude : [exclude]
  const out: string[] = []
  for (const raw of list) {
    for (const p of raw.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean)) {
      const stripped = p.startsWith("!") ? p.slice(1) : p
      const n = normalizePathConstraint(stripped)
      if (n) out.push(`!${n}`)
    }
  }
  return out
}
