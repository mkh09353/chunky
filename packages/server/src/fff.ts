// Shared FFF (https://github.com/dmtrKovalenko/fff) FileFinder for the server.
// One long-lived index over WORKSPACE powers agent tools (fffind/ffgrep) and the
// TUI's @-mention autocomplete (GET /api/files/search). Lazy-init so unit tests
// that never search never pay for the native scan.
import { mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { FileFinder } from "@ff-labs/fff-bun"
import { WORKSPACE } from "./workspace.ts"

/** Where FFF keeps frecency + query-history DBs. Prefer the state dir next to
 *  settings.json (launcher sets CHUNKY_SETTINGS → ~/.chunky/state/settings.json). */
function fffStateDir(): string {
  const settings = process.env.CHUNKY_SETTINGS
  if (settings) return join(dirname(settings), "fff")
  // Dev / tests without the launcher: keep DBs next to the workspace.
  return join(WORKSPACE, ".chunky-fff")
}

let finder: FileFinder | null = null
let finderPromise: Promise<FileFinder> | null = null
let finderBase: string | null = null

/**
 * Get (or create) the workspace FileFinder. Concurrent callers share one
 * in-flight create — FFF's native DB locks deadlock if two create() race.
 */
export async function getFinder(basePath: string = WORKSPACE): Promise<FileFinder> {
  if (finder && !finder.isDestroyed && finderBase === basePath) return finder
  if (finderPromise) return finderPromise

  finderPromise = (async () => {
    if (finder && !finder.isDestroyed) {
      finder.destroy()
      finder = null
      finderBase = null
    }

    const stateDir = fffStateDir()
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
      // WORKSPACE is the project root; never index $HOME or /.
      enableHomeDirScanning: false,
      enableFsRootScanning: false,
    })
    if (!result.ok) {
      throw new Error(`FFF init failed: ${result.error}`)
    }
    finder = result.value
    finderBase = basePath
    // Cap wait so a huge repo doesn't block the first tool call forever.
    await finder.waitForScan(15_000)
    return finder
  })().finally(() => {
    finderPromise = null
  })

  return finderPromise
}

/** Tear down the finder (tests / process shutdown). */
export function destroyFinder(): void {
  if (finder && !finder.isDestroyed) finder.destroy()
  finder = null
  finderBase = null
  finderPromise = null
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
