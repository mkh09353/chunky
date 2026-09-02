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
// AND NO GIT EVER RUNS ON THE REQUEST PATH. Lookups are synchronous Map reads;
// git runs asynchronously in the background (stale-while-revalidate):
//   · fresh entry   → served.
//   · expired entry → the stale value is served NOW and one refresh is queued.
//   · never seen    → null is served (clients render flat) and a resolve is queued.
// At most one resolve is in flight per workspace. When a background resolve
// stores a value that DIFFERS from what was being served, `onResolved` fires
// so the session stream can re-emit the affected rows within its debounce
// instead of waiting for a client poll.
//
// Ordering of sources, cheapest first:
//   1. `session_workspaces` (Store.workspaceMetadataOf) — the fork worktree's
//      branch and path were recorded when it was created. No subprocess at all.
//   2. `git rev-parse --show-toplevel` + `git worktree list --porcelain`, cached
//      and resolved in the background (see below).
//
// NOTHING here may throw and nothing may be fatal: a deleted worktree, an
// unmounted volume, a detached HEAD, a missing git binary and a plain
// non-repository folder all degrade to "omit the fields", which clients read
// as "render flat".
//
// Run with: bun test src/worktrees.test.ts
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
 *  so the cache and fallback rules are testable without a real repository. A
 *  synchronous runner (the scripted fakes in tests) is accepted as-is. */
export type GitRunner = (args: string[], cwd: string) => string | null | Promise<string | null>

/** Arguments are always an ARRAY — never a shell string, so a path containing
 *  spaces, quotes or `;` is data and can never become a command. Asynchronous
 *  on purpose: this is only ever called from a background resolve, and a
 *  blocking spawn here would stall every request in flight for its duration. */
export const spawnGit: GitRunner = async (args, cwd) => {
  try {
    const proc = Bun.spawn(["git", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "ignore" })
    const timer = setTimeout(() => { try { proc.kill() } catch { /* already gone */ } }, GIT_TIMEOUT_MS)
    try {
      const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
      return code === 0 ? stdout : null
    } finally {
      clearTimeout(timer)
    }
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

/** Fires (with the resolved, canonical workspace key) when a background resolve
 *  stored an answer that differs from what was being served for it — a miss
 *  filling in counts, a refresh confirming the same answer does not. */
export type ResolvedListener = (workspacePath: string) => void

export interface ResolverOptions {
  git?: GitRunner
  now?: () => number
  ttlMs?: number
  /** Injectable so "the worktree was deleted" is testable without a filesystem. */
  exists?: (path: string) => boolean
  onResolved?: ResolvedListener
}

/** How many background git resolves may run at once. A cold boot with sessions
 *  spread over hundreds of folders must not fork hundreds of git processes in
 *  one tick; the rest wait their turn (still off the request path). */
const MAX_CONCURRENT_RESOLVES = 4

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
  /** Keys with a background resolve queued or running: at most one each. */
  private readonly inflight = new Map<string, Promise<void>>()
  private readonly waiting: (() => void)[] = []
  private active = 0
  /** Test/diagnostic counter: how many workspaces were actually resolved by git. */
  private spawns = 0
  /** Notified after a background resolve CHANGED a workspace's answer. */
  onResolved: ResolvedListener | null

  constructor(options: ResolverOptions = {}) {
    this.git = options.git ?? spawnGit
    this.now = options.now ?? Date.now
    this.ttlMs = options.ttlMs ?? WORKTREE_TTL_MS
    this.exists = options.exists ?? existsSync
    this.onResolved = options.onResolved ?? null
  }

  /** How many times git was consulted. Only cache misses/refreshes increment it. */
  get gitCalls(): number {
    return this.spawns
  }

  /** Background resolves queued or running right now. */
  get pending(): number {
    return this.inflight.size
  }

  /** Settles once every background resolve — including any scheduled by an
   *  `onResolved` listener while waiting — has stored its result. For tests
   *  and the manual verifier; the server never awaits this. */
  async flush(): Promise<void> {
    while (this.inflight.size > 0) await Promise.all([...this.inflight.values()])
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
    // Delete first so a refreshed key moves to the young end of the Map.
    store.delete(key)
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
   * Resolve a workspace from the cache: the answer, null when it is not inside
   * a usable git repository, or null when it has simply not been resolved YET.
   *
   * Never waits for git. A fresh entry is served as is; an expired one is
   * served stale while one background refresh runs; a never-seen workspace
   * gets a background resolve and null for now. Both positive and negative
   * outcomes are cached for the TTL: refuting a folder must not be more
   * expensive than confirming one, or every delta would re-spawn git for every
   * non-repository session.
   */
  resolve(workspace: string): WorkspaceGit | null {
    const key = safeResolve(workspace)
    if (!key) return null
    const entry = this.cache.get(key)
    if (entry && this.now() - entry.at < this.ttlMs) return entry.value
    this.schedule(key)
    return entry?.value ?? null
  }

  /** Start resolving a workspace in the background unless it is already fresh.
   *  Server start pre-warms every registered repo through this. */
  warm(workspace: string): void {
    this.resolve(workspace)
  }

  /**
   * Every worktree path belonging to the repository rooted at `repoPath`, main
   * worktree first. Falls back to the path itself so a caller can always use
   * the result as a workspace set, repository or not (or not yet resolved).
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

  /** Drop everything (a repo was added/removed, or a test wants a fresh start).
   *  Resolves already in flight complete and store their (fresh) answers. */
  clear(): void {
    this.cache.clear()
    this.existsCache.clear()
    this.spawns = 0
  }

  /** Queue one background resolve for `key` unless one is already in flight. */
  private schedule(key: string): void {
    if (this.inflight.has(key)) return
    const served = this.cache.get(key)?.value ?? null
    const task = this.acquire()
      .then(() => this.query(key))
      .catch(() => null)
      .then((value) => {
        this.remember(this.cache, key, value)
        if (!sameGit(served, value)) this.announce(key)
      })
      .finally(() => {
        this.inflight.delete(key)
        this.release()
      })
    this.inflight.set(key, task)
  }

  private acquire(): Promise<void> {
    if (this.active < MAX_CONCURRENT_RESOLVES) {
      this.active += 1
      return Promise.resolve()
    }
    return new Promise((grant) => this.waiting.push(grant))
  }

  private release(): void {
    const next = this.waiting.shift()
    // Hand the slot straight to the next waiter, otherwise free it.
    if (next) next()
    else this.active -= 1
  }

  private announce(key: string): void {
    try {
      this.onResolved?.(key)
    } catch {
      // Decoration: a listener must never break resolution or the cache.
    }
  }

  private async query(workspace: string): Promise<WorkspaceGit | null> {
    if (!this.pathExists(workspace)) return null
    this.spawns += 1
    const top = await this.git(["rev-parse", "--show-toplevel"], workspace)
    if (top == null) return null
    const toplevel = safeResolve(top.trim())
    if (!toplevel) return null
    const porcelain = await this.git(["worktree", "list", "--porcelain"], workspace)
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

/** Did a background resolve change the answer? Null (never resolved) and null
 *  (refuted) compare equal on purpose: refuting a plain folder is not news. */
function sameGit(a: WorkspaceGit | null, b: WorkspaceGit | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.mainPath === b.mainPath && a.branch === b.branch && a.linked === b.linked
    && a.worktrees.length === b.worktrees.length && a.worktrees.every((path, i) => path === b.worktrees[i])
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

/** The server-wide instance. One cache for every session-summary builder.
 *  index.ts sets `onResolved` so the session stream re-emits affected rows. */
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
