// Workspace → (repository, branch, worktree) resolution for session rows.
//
// A session stores only its absolute `workspace` path. That is enough to list
// it under a repo tab while every session lives at a repo root, but it says
// nothing once linked git worktrees are involved: a `/fork --worktree` child
// runs in <state>/worktrees/<repo>/<slug>, which is neither the repo path the
// client asked for nor something a client could map back on its own.
//
// This module answers both questions for the session-summary builders:
//
//   · which REPOSITORY a workspace belongs to (its main worktree), and
//   · which BRANCH / linked worktree the session is actually working in.
//
// COST IS THE WHOLE DESIGN. `sessionStream` re-emits every changed row on a
// 250ms debounce and `shellSessions()` is unbounded, so a `git` spawn per row
// per delta is not an option. Everything here goes through one cache keyed by
// resolved workspace path, with NEGATIVE results cached just as hard as
// positive ones — a workspace that is not a repository must cost one spawn
// ever, not one per delta. Within the TTL a lookup is a Map hit and nothing
// else.
//
// Ordering of sources, cheapest first:
//   1. `session_workspaces` (Store.workspaceMetadataOf) — the fork worktree's
//      branch and path were recorded when it was created. No subprocess at all.
//   2. `git rev-parse --show-toplevel` + `git worktree list --porcelain`, cached.
//
// NOTHING here may throw and nothing may be fatal: a deleted worktree, an
// unmounted volume, a detached HEAD, a missing git binary and a plain
// non-repository folder all degrade to "omit the fields", which clients read
// as "render flat".
//
// Run with: bun test src/worktrees.test.ts
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { resolve } from "node:path"

/** How long a resolved (or refuted) workspace stays cached. */
export const WORKTREE_TTL_MS = 30_000
/** Hard ceiling so a long-lived server cannot grow this without bound. */
export const WORKTREE_CACHE_MAX = 512
/** No git invocation here may hang a session list. */
const GIT_TIMEOUT_MS = 5_000

/** What git knows about one workspace. */
export interface WorkspaceGit {
  /** Absolute path of the repository's MAIN worktree. */
  mainPath: string
  /** Branch checked out in the queried workspace; null on a detached HEAD. */
  branch: string | null
  /** The queried workspace is a LINKED worktree, not the main one. */
  linked: boolean
  /** Every worktree path of this repository, main worktree first. */
  worktrees: string[]
}

/** Runs git and returns stdout, or null for any failure whatsoever. Injectable
 *  so the cache and fallback rules are testable without a real repository. */
export type GitRunner = (args: string[], cwd: string) => string | null

/** Arguments are always an ARRAY — never a shell string, so a path containing
 *  spaces, quotes or `;` is data and can never become a command. */
export const spawnGit: GitRunner = (args, cwd) => {
  try {
    const result = spawnSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    })
    if (result.error || result.status !== 0 || typeof result.stdout !== "string") return null
    return result.stdout
  } catch {
    return null
  }
}

/** One `git worktree list --porcelain` record. */
interface PorcelainRecord {
  path: string
  branch: string | null
}

/**
 * Parse `git worktree list --porcelain`.
 *
 * Records are separated by a blank line and always open with `worktree <path>`;
 * the FIRST record is the repository's main worktree. `branch refs/heads/x`
 * names the checkout, and its absence (a bare `detached` line, or nothing at
 * all) means there is no branch to report.
 *
 * Exported for tests: this is the only format-sensitive code in the module.
 */
export function parseWorktreePorcelain(stdout: string): PorcelainRecord[] {
  const records: PorcelainRecord[] = []
  let current: PorcelainRecord | null = null
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trimEnd()
    if (line.startsWith("worktree ")) {
      if (current) records.push(current)
      current = { path: line.slice("worktree ".length), branch: null }
      continue
    }
    if (!current) continue
    if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "") || null
    }
  }
  if (current) records.push(current)
  return records.filter((record) => record.path.length > 0)
}

interface CacheEntry<T> {
  at: number
  value: T
}

export interface ResolverOptions {
  git?: GitRunner
  now?: () => number
  ttlMs?: number
  /** Injectable so "the worktree was deleted" is testable without a filesystem. */
  exists?: (path: string) => boolean
}

/**
 * A workspace resolver with its own cache. The server uses one shared instance
 * (`worktreeResolver`); tests build isolated ones so cache behaviour can be
 * asserted without global state.
 */
export class WorktreeResolver {
  private readonly git: GitRunner
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly exists: (path: string) => boolean
  private readonly cache = new Map<string, CacheEntry<WorkspaceGit | null>>()
  private readonly existsCache = new Map<string, CacheEntry<boolean>>()
  /** Test/diagnostic counter: how many workspaces were actually resolved by git. */
  private spawns = 0

  constructor(options: ResolverOptions = {}) {
    this.git = options.git ?? spawnGit
    this.now = options.now ?? Date.now
    this.ttlMs = options.ttlMs ?? WORKTREE_TTL_MS
    this.exists = options.exists ?? existsSync
  }

  /** How many times git was consulted. Only cache misses increment it. */
  get gitCalls(): number {
    return this.spawns
  }

  private fresh<T>(store: Map<string, CacheEntry<T>>, key: string): CacheEntry<T> | null {
    const entry = store.get(key)
    if (!entry) return null
    if (this.now() - entry.at >= this.ttlMs) {
      store.delete(key)
      return null
    }
    return entry
  }

  private remember<T>(store: Map<string, CacheEntry<T>>, key: string, value: T): T {
    store.set(key, { at: this.now(), value })
    // Insertion-ordered eviction: the oldest key is the first one Map yields.
    while (store.size > WORKTREE_CACHE_MAX) {
      const oldest = store.keys().next()
      if (oldest.done) break
      store.delete(oldest.value)
    }
    return value
  }

  /** Cached `existsSync`, so a per-row staleness check is not a per-row stat. */
  pathExists(path: string): boolean {
    const key = safeResolve(path)
    if (!key) return false
    const cached = this.fresh(this.existsCache, key)
    if (cached) return cached.value
    let value = false
    try {
      value = this.exists(key)
    } catch {
      value = false
    }
    return this.remember(this.existsCache, key, value)
  }

  /**
   * Resolve a workspace, or null when it is not inside a usable git repository.
   *
   * Both outcomes are cached for the TTL: refuting a folder must not be more
   * expensive than confirming one, or every delta would re-spawn git for every
   * non-repository session.
   */
  resolve(workspace: string): WorkspaceGit | null {
    const key = safeResolve(workspace)
    if (!key) return null
    const cached = this.fresh(this.cache, key)
    if (cached) return cached.value
    return this.remember(this.cache, key, this.query(key))
  }

  /**
   * Every worktree path belonging to the repository rooted at `repoPath`, main
   * worktree first. Falls back to the path itself so a caller can always use
   * the result as a workspace set, repository or not.
   */
  worktreePathsFor(repoPath: string): string[] {
    const key = safeResolve(repoPath)
    if (!key) return []
    const info = this.resolve(key)
    if (!info || info.worktrees.length === 0) return [key]
    // The queried path must always be in its own set: `git worktree list`
    // reports canonical paths, and a caller that asked about a symlinked or
    // differently-spelled root still stores sessions under the spelling it used.
    return info.worktrees.includes(key) ? info.worktrees : [key, ...info.worktrees]
  }

  /** Drop everything (a repo was added/removed, or a test wants a fresh start). */
  clear(): void {
    this.cache.clear()
    this.existsCache.clear()
    this.spawns = 0
  }

  private query(workspace: string): WorkspaceGit | null {
    if (!this.pathExists(workspace)) return null
    this.spawns += 1
    const top = this.git(["rev-parse", "--show-toplevel"], workspace)
    if (top == null) return null
    const toplevel = safeResolve(top.trim())
    if (!toplevel) return null
    const porcelain = this.git(["worktree", "list", "--porcelain"], workspace)
    if (porcelain == null) return null
    const records = parseWorktreePorcelain(porcelain)
    if (records.length === 0) return null
    const worktrees: string[] = []
    for (const record of records) {
      const path = safeResolve(record.path)
      if (path && !worktrees.includes(path)) worktrees.push(path)
    }
    const mainPath = worktrees[0]
    if (!mainPath) return null
    const mine = records.find((record) => safeResolve(record.path) === toplevel)
    return {
      mainPath,
      branch: mine?.branch ?? null,
      linked: toplevel !== mainPath,
      worktrees,
    }
  }
}

/** `resolve()` on a value that may be empty or malformed, without throwing. */
function safeResolve(path: string | null | undefined): string | null {
  if (typeof path !== "string" || path.length === 0 || path.includes("\0")) return null
  try {
    return resolve(path)
  } catch {
    return null
  }
}

/** The server-wide instance. One cache for every session-summary builder. */
export const worktreeResolver = new WorktreeResolver()

// ---- Repository workspace set ----------------------------------------------

/**
 * Every workspace a repository's tab must cover.
 *
 * Two sources, because neither alone is sufficient:
 *
 *   · `git worktree list` — finds worktrees Chunky knows nothing about (ones the
 *     user cut by hand), but reports CANONICAL paths.
 *   · `session_workspaces` — the path a `/fork --worktree` child was actually
 *     stored under, which is the path the fork wrote, not git's canonical form.
 *
 * Where a path component is a symlink those two spellings differ, so a set built
 * from git alone would silently drop Chunky's own worktree forks from the tab
 * they belong to. The union cannot miss either kind.
 *
 * Never empty for a real path: an empty set would blank the repository's tab.
 */
export function repoWorkspaceSet(
  repoPath: string,
  recordedWorktreesUnder: (parentWorkspaces: readonly string[]) => string[],
  resolver: WorktreeResolver = worktreeResolver,
): string[] {
  const fromGit = resolver.worktreePathsFor(repoPath)
  if (fromGit.length === 0) return []
  const recorded = safeCall(() => recordedWorktreesUnder(fromGit)) ?? []
  return [...new Set([...fromGit, ...recorded.filter((path) => typeof path === "string" && path.length > 0)])]
}

// ---- Session summary fields ------------------------------------------------

/** The optional SessionSummary fields this module can populate. */
export interface SessionGitFields {
  repoId?: string
  branch?: string
  worktree?: { path: string; isLinked: true }
}

/**
 * The store/registry reads `sessionGitFields` needs, injected rather than
 * imported (the same shape `resolveFileSearchWorkspace` uses) so the rules are
 * testable without a database or a repos.json.
 */
export interface SessionGitLookup {
  /** `session_workspaces` — present only for `/fork --worktree` children. */
  workspaceMetadataOf(sessionId: string): { path: string; branch: string; parentSessionId: string } | null
  workspaceOf(sessionId: string): string | null
  /** Registry id of the repository at this exact path, or null if unregistered. */
  repoIdForPath(path: string): string | null
}

/**
 * Resolve one session's repo/branch/worktree fields.
 *
 * Fast path first: a fork worktree recorded its branch and path at creation, so
 * a row that has `session_workspaces` metadata costs ZERO subprocesses — its
 * repo comes from the parent session's workspace, which is a plain row read.
 * Only a directory session (or a fork whose worktree has since been deleted)
 * reaches git, and that answer is cached per workspace for the TTL.
 *
 * Every field is independently optional: a resolvable branch is still reported
 * when the repository is not in the registry, and vice versa. Nothing throws.
 */
export function sessionGitFields(
  sessionId: string,
  workspace: string,
  lookup: SessionGitLookup,
  resolver: WorktreeResolver = worktreeResolver,
): SessionGitFields {
  try {
    const fast = forkWorktreeFields(sessionId, lookup, resolver)
    if (fast) return fast
    return directoryFields(workspace, resolver, lookup)
  } catch {
    // Resolution is decoration. A client that gets no fields renders flat,
    // which is exactly the pre-worktree behaviour — never an error.
    return {}
  }
}

/** Source 1: `session_workspaces`. No subprocess; returns null when it does not
 *  apply (not a fork worktree, or the worktree no longer exists on disk). */
function forkWorktreeFields(
  sessionId: string,
  lookup: SessionGitLookup,
  resolver: WorktreeResolver,
): SessionGitFields | null {
  const metadata = safeCall(() => lookup.workspaceMetadataOf(sessionId))
  if (!metadata?.path) return null
  // A worktree the user (or `removeForkWorktree`) deleted must not keep
  // claiming a branch. Fall through to git, which will refute it too.
  if (!resolver.pathExists(metadata.path)) return null
  const fields: SessionGitFields = {
    worktree: { path: safeResolveOr(metadata.path), isLinked: true },
  }
  if (metadata.branch) fields.branch = metadata.branch
  const parentWorkspace = metadata.parentSessionId
    ? safeCall(() => lookup.workspaceOf(metadata.parentSessionId))
    : null
  const repoId = parentWorkspace ? safeCall(() => lookup.repoIdForPath(parentWorkspace)) : null
  if (repoId) fields.repoId = repoId
  return fields
}

/** Source 2: git, cached. Used for ordinary directory sessions and for forks
 *  whose recorded worktree is gone. */
function directoryFields(
  workspace: string,
  resolver: WorktreeResolver,
  lookup: SessionGitLookup,
): SessionGitFields {
  const info = resolver.resolve(workspace)
  if (!info) return {}
  const fields: SessionGitFields = {}
  if (info.branch) fields.branch = info.branch
  const repoId = safeCall(() => lookup.repoIdForPath(info.mainPath))
  if (repoId) fields.repoId = repoId
  if (info.linked) fields.worktree = { path: safeResolveOr(workspace), isLinked: true }
  return fields
}

function safeResolveOr(path: string): string {
  return safeResolve(path) ?? path
}

function safeCall<T>(fn: () => T): T | null {
  try {
    return fn()
  } catch {
    return null
  }
}
