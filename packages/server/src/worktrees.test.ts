// Worktree/branch resolution for session rows.
//
// The cost rules are as load-bearing as the answers here: these rows are built
// for every session on every 250ms session-stream delta, so "how many times did
// git run" is asserted as carefully as "what did it say".
//
// Run with: bun test src/worktrees.test.ts
import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  WorktreeResolver,
  parseWorktreePorcelain,
  repoWorkspaceSet,
  sessionGitFields,
  type GitRunner,
  type SessionGitLookup,
} from "./worktrees.ts"
import { Store } from "./store.ts"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A scripted git that records every invocation. */
function fakeGit(responses: Record<string, string | null>) {
  const calls: { args: string[]; cwd: string }[] = []
  const runner: GitRunner = (args, cwd) => {
    calls.push({ args, cwd })
    return responses[args[0] === "rev-parse" ? "rev-parse" : "worktree"] ?? null
  }
  return { runner, calls }
}

const MAIN = "/repos/widget"
const LINKED = "/state/worktrees/widget-abc"
const PORCELAIN = [
  `worktree ${MAIN}`,
  "HEAD 1111111111111111111111111111111111111111",
  "branch refs/heads/main",
  "",
  `worktree ${LINKED}`,
  "HEAD 2222222222222222222222222222222222222222",
  "branch refs/heads/chunky/widget-abc",
  "",
].join("\n")

/** A scripted git whose answers can be held back, so "in flight" is observable. */
function gatedGit(responses: Record<string, string | null>) {
  const calls: { args: string[]; cwd: string }[] = []
  let open: () => void = () => {}
  let gate = Promise.resolve()
  const runner: GitRunner = async (args, cwd) => {
    calls.push({ args, cwd })
    await gate
    return responses[args[0] === "rev-parse" ? "rev-parse" : "worktree"] ?? null
  }
  return {
    runner,
    calls,
    hold: () => { gate = new Promise<void>((resolve) => { open = resolve }) },
    release: () => open(),
  }
}

function resolverFor(top: string, options: { now?: () => number; ttlMs?: number; onResolved?: (path: string) => void } = {}) {
  const git = fakeGit({ "rev-parse": `${top}\n`, worktree: PORCELAIN })
  const resolver = new WorktreeResolver({
    git: git.runner,
    exists: () => true,
    now: options.now,
    ttlMs: options.ttlMs,
    onResolved: options.onResolved,
  })
  return { resolver, git }
}

/** Read once (which schedules the background resolve), let it land, read again. */
async function settled<T>(resolver: WorktreeResolver, read: () => T): Promise<T> {
  read()
  await resolver.flush()
  return read()
}

const emptyLookup: SessionGitLookup = {
  workspaceMetadataOf: () => null,
  workspaceOf: () => null,
  repoIdForPath: () => null,
}

// ---- porcelain parsing -----------------------------------------------------

test("worktree porcelain parses main-first records and strips refs/heads/", () => {
  const records = parseWorktreePorcelain(PORCELAIN)
  expect(records).toEqual([
    { path: MAIN, branch: "main" },
    { path: LINKED, branch: "chunky/widget-abc" },
  ])
})

test("a detached worktree reports no branch rather than a fake one", () => {
  const records = parseWorktreePorcelain(
    [`worktree ${MAIN}`, "HEAD 1111111111111111111111111111111111111111", "detached", ""].join("\n"),
  )
  expect(records).toEqual([{ path: MAIN, branch: null }])
})

test("empty or junk porcelain yields no records instead of throwing", () => {
  expect(parseWorktreePorcelain("")).toEqual([])
  expect(parseWorktreePorcelain("branch refs/heads/orphan\nHEAD abc")).toEqual([])
})

// ---- resolution ------------------------------------------------------------

test("the main worktree resolves to itself and is not reported as linked", async () => {
  const { resolver } = resolverFor(MAIN)
  expect(await settled(resolver, () => resolver.resolve(MAIN))).toEqual({
    mainPath: MAIN,
    branch: "main",
    linked: false,
    worktrees: [MAIN, LINKED],
  })
})

test("a linked worktree reports its own branch and the repository's main path", async () => {
  const { resolver } = resolverFor(LINKED)
  expect(await settled(resolver, () => resolver.resolve(LINKED))).toEqual({
    mainPath: MAIN,
    branch: "chunky/widget-abc",
    linked: true,
    worktrees: [MAIN, LINKED],
  })
})

// ---- caching (the whole point of the module) -------------------------------

test("repeated resolution inside the TTL consults git exactly once", async () => {
  const { resolver, git } = resolverFor(MAIN)
  for (let i = 0; i < 50; i++) resolver.resolve(MAIN)
  await resolver.flush()
  for (let i = 0; i < 50; i++) resolver.resolve(MAIN)
  expect(resolver.gitCalls).toBe(1)
  // rev-parse + worktree list, and nothing more.
  expect(git.calls).toHaveLength(2)
})

test("a NON-repository workspace is refuted once, not once per delta", async () => {
  const git = fakeGit({ "rev-parse": null, worktree: null })
  const resolver = new WorktreeResolver({ git: git.runner, exists: () => true })
  for (let i = 0; i < 50; i++) expect(resolver.resolve("/tmp/not-a-repo")).toBeNull()
  await resolver.flush()
  for (let i = 0; i < 50; i++) expect(resolver.resolve("/tmp/not-a-repo")).toBeNull()
  // Negative caching is what stops a folder full of non-repo sessions from
  // spawning git on every 250ms session-stream delta.
  expect(resolver.gitCalls).toBe(1)
})

test("a missing path is refuted without invoking git at all", async () => {
  const git = fakeGit({ "rev-parse": `${MAIN}\n`, worktree: PORCELAIN })
  const resolver = new WorktreeResolver({ git: git.runner, exists: () => false })
  expect(resolver.resolve("/gone")).toBeNull()
  await resolver.flush()
  expect(resolver.resolve("/gone")).toBeNull()
  expect(git.calls).toHaveLength(0)
})

test("the cache expires on the TTL and re-resolves afterwards", async () => {
  let clock = 1_000
  const { resolver } = resolverFor(MAIN, { now: () => clock, ttlMs: 30_000 })
  resolver.resolve(MAIN)
  await resolver.flush()
  clock += 29_999
  resolver.resolve(MAIN)
  await resolver.flush()
  expect(resolver.gitCalls).toBe(1)
  clock += 2
  resolver.resolve(MAIN)
  await resolver.flush()
  expect(resolver.gitCalls).toBe(2)
})

// ---- stale-while-revalidate (git never runs on the request path) -----------

test("a never-seen workspace is null NOW and resolves in the background", async () => {
  const resolved: string[] = []
  const { resolver, git } = resolverFor(MAIN, { onResolved: (path) => resolved.push(path) })
  // The request path gets its answer synchronously: nothing yet, render flat.
  expect(resolver.resolve(MAIN)).toBeNull()
  expect(resolver.pending).toBe(1)
  // …and git has not been consulted inside that call.
  expect(git.calls).toHaveLength(0)
  await resolver.flush()
  expect(resolver.pending).toBe(0)
  expect(resolver.resolve(MAIN)?.branch).toBe("main")
  // null → value is a change worth announcing, once, with the canonical key.
  expect(resolved).toEqual([MAIN])
})

test("an expired entry is served STALE while exactly one refresh runs", async () => {
  let clock = 1_000
  const git = gatedGit({ "rev-parse": `${MAIN}\n`, worktree: PORCELAIN })
  const resolver = new WorktreeResolver({ git: git.runner, exists: () => true, now: () => clock, ttlMs: 30_000 })
  await settled(resolver, () => resolver.resolve(MAIN))
  expect(resolver.gitCalls).toBe(1)
  clock += 30_001
  git.hold()
  // Expired: every caller still gets the old answer immediately…
  for (let i = 0; i < 20; i++) expect(resolver.resolve(MAIN)?.branch).toBe("main")
  // …while ONE refresh (not twenty) is in flight for the key.
  expect(resolver.pending).toBe(1)
  git.release()
  await resolver.flush()
  expect(resolver.gitCalls).toBe(2)
  expect(resolver.resolve(MAIN)?.branch).toBe("main")
})

test("at most one background resolve is in flight per key, across keys", async () => {
  const git = gatedGit({ "rev-parse": `${MAIN}\n`, worktree: PORCELAIN })
  const resolver = new WorktreeResolver({ git: git.runner, exists: () => true })
  git.hold()
  for (let i = 0; i < 10; i++) {
    resolver.resolve(MAIN)
    resolver.resolve(LINKED)
  }
  expect(resolver.pending).toBe(2)
  git.release()
  await resolver.flush()
  expect(resolver.gitCalls).toBe(2)
  expect(git.calls).toHaveLength(4)
})

test("onResolved fires only when the answer CHANGED", async () => {
  let clock = 1_000
  let branch = "main"
  const resolved: string[] = []
  const git: GitRunner = (args) =>
    args[0] === "rev-parse"
      ? `${MAIN}\n`
      : [`worktree ${MAIN}`, "HEAD 1111", `branch refs/heads/${branch}`, ""].join("\n")
  const resolver = new WorktreeResolver({
    git,
    exists: () => true,
    now: () => clock,
    ttlMs: 30_000,
    onResolved: (path) => resolved.push(path),
  })
  await settled(resolver, () => resolver.resolve(MAIN))
  expect(resolved).toEqual([MAIN])
  // A refresh that confirms the same answer is not news.
  clock += 30_001
  await settled(resolver, () => resolver.resolve(MAIN))
  expect(resolved).toEqual([MAIN])
  // A refresh that finds a different branch is.
  clock += 30_001
  branch = "feature"
  expect(resolver.resolve(MAIN)?.branch).toBe("main")
  await resolver.flush()
  expect(resolver.resolve(MAIN)?.branch).toBe("feature")
  expect(resolved).toEqual([MAIN, MAIN])
})

test("negative results are cached and never announced (null → null is not a change)", async () => {
  let clock = 1_000
  const resolved: string[] = []
  const git = fakeGit({ "rev-parse": null, worktree: null })
  const resolver = new WorktreeResolver({
    git: git.runner,
    exists: () => true,
    now: () => clock,
    ttlMs: 30_000,
    onResolved: (path) => resolved.push(path),
  })
  await settled(resolver, () => resolver.resolve("/tmp/plain"))
  for (let i = 0; i < 50; i++) expect(resolver.resolve("/tmp/plain")).toBeNull()
  expect(resolver.gitCalls).toBe(1)
  expect(resolver.pending).toBe(0)
  expect(resolved).toEqual([])
  // The refutation expires like a positive answer and is re-checked once.
  clock += 30_001
  await settled(resolver, () => resolver.resolve("/tmp/plain"))
  expect(resolver.gitCalls).toBe(2)
  expect(resolved).toEqual([])
})

test("a throwing or rejecting git runner, or a throwing listener, degrades to a cached null", async () => {
  const throwing = new WorktreeResolver({ git: () => { throw new Error("no git") }, exists: () => true })
  await settled(throwing, () => throwing.resolve(MAIN))
  expect(throwing.resolve(MAIN)).toBeNull()
  expect(throwing.pending).toBe(0)
  const rejecting = new WorktreeResolver({ git: () => Promise.reject(new Error("no git")), exists: () => true })
  await settled(rejecting, () => rejecting.resolve(MAIN))
  expect(rejecting.resolve(MAIN)).toBeNull()
  const { resolver } = resolverFor(MAIN, { onResolved: () => { throw new Error("listener bug") } })
  expect(await settled(resolver, () => resolver.resolve(MAIN)?.branch)).toBe("main")
})

test("a synchronous and an asynchronous git runner are both accepted", async () => {
  const sync = new WorktreeResolver({ git: () => `${MAIN}\n`, exists: () => true })
  const async = new WorktreeResolver({ git: async () => `${MAIN}\n`, exists: () => true })
  // Both runners answer every call with a path, which parses to one main record.
  expect((await settled(sync, () => sync.resolve(MAIN)))?.mainPath).toBeUndefined()
  expect((await settled(async, () => async.resolve(MAIN)))?.mainPath).toBeUndefined()
  expect(sync.gitCalls).toBe(1)
  expect(async.gitCalls).toBe(1)
})

test("worktreePathsFor returns the repository's whole set, and degrades to the path itself", async () => {
  const { resolver } = resolverFor(MAIN)
  // Unresolved yet: the path itself, never empty; resolved: the whole set.
  expect(resolver.worktreePathsFor(MAIN)).toEqual([MAIN])
  await resolver.flush()
  expect(resolver.worktreePathsFor(MAIN)).toEqual([MAIN, LINKED])
  const nonRepo = new WorktreeResolver({
    git: fakeGit({ "rev-parse": null, worktree: null }).runner,
    exists: () => true,
  })
  // Never empty for a real path: the caller uses this as a workspace set, and
  // an empty set would blank the repo's tab.
  expect(nonRepo.worktreePathsFor("/tmp/plain-folder")).toEqual([resolve("/tmp/plain-folder")])
  expect(nonRepo.worktreePathsFor("")).toEqual([])
})

// ---- repository workspace set ----------------------------------------------

test("repoWorkspaceSet unions git's worktrees with the paths forks recorded", async () => {
  const { resolver } = resolverFor(MAIN)
  const recorded = "/state/worktrees/widget-recorded"
  expect(await settled(resolver, () => repoWorkspaceSet(MAIN, () => [recorded], resolver))).toEqual([MAIN, LINKED, recorded])
})

test("repoWorkspaceSet survives a throwing store read and still covers the repo", async () => {
  const { resolver } = resolverFor(MAIN)
  const boom = () => { throw new Error("db is gone") }
  expect(await settled(resolver, () => repoWorkspaceSet(MAIN, boom, resolver))).toEqual([MAIN, LINKED])
})

test("repoWorkspaceSet on a plain folder is still the folder itself, never empty", () => {
  const resolver = new WorktreeResolver({
    git: fakeGit({ "rev-parse": null, worktree: null }).runner,
    exists: () => true,
  })
  expect(repoWorkspaceSet("/tmp/plain", () => [], resolver)).toEqual([resolve("/tmp/plain")])
})

test("building a whole session list costs a BOUNDED number of git calls", async () => {
  const { resolver } = resolverFor(MAIN)
  const lookup: SessionGitLookup = { ...emptyLookup, repoIdForPath: () => "rwidget" }
  // 200 rows across two workspaces, re-emitted 20 times (the 250ms delta cadence),
  // with the background resolves landing somewhere in the middle.
  for (let delta = 0; delta < 20; delta++) {
    for (let row = 0; row < 100; row++) {
      sessionGitFields(`s${row}`, MAIN, lookup, resolver)
      sessionGitFields(`l${row}`, LINKED, lookup, resolver)
    }
    if (delta === 10) await resolver.flush()
  }
  await resolver.flush()
  // One per distinct workspace, for the whole TTL — not one per row per delta.
  expect(resolver.gitCalls).toBe(2)
})

// ---- summary fields: session_workspaces fast path --------------------------

test("a fork-worktree session gets branch, worktree and repo WITHOUT touching git", async () => {
  const { resolver, git } = resolverFor(MAIN)
  const lookup: SessionGitLookup = {
    workspaceMetadataOf: (id) =>
      id === "child" ? { path: LINKED, branch: "chunky/widget-abc", parentSessionId: "parent" } : null,
    workspaceOf: (id) => (id === "parent" ? MAIN : null),
    repoIdForPath: (path) => (path === MAIN ? "rwidget" : null),
  }
  expect(sessionGitFields("child", LINKED, lookup, resolver)).toEqual({
    repoId: "rwidget",
    branch: "chunky/widget-abc",
    worktree: { path: LINKED, isLinked: true },
  })
  // The whole point of the fast path: the recorded metadata already knows, so
  // nothing was even scheduled in the background.
  await resolver.flush()
  expect(git.calls).toHaveLength(0)
  expect(resolver.gitCalls).toBe(0)
  expect(resolver.pending).toBe(0)
})

test("a fork worktree whose directory is gone reports nothing rather than a stale branch", () => {
  const git = fakeGit({ "rev-parse": null, worktree: null })
  const resolver = new WorktreeResolver({ git: git.runner, exists: () => false })
  const lookup: SessionGitLookup = {
    workspaceMetadataOf: () => ({ path: LINKED, branch: "chunky/gone", parentSessionId: "parent" }),
    workspaceOf: () => MAIN,
    repoIdForPath: () => "rwidget",
  }
  expect(sessionGitFields("child", LINKED, lookup, resolver)).toEqual({})
})

test("a fork worktree still reports its branch when its repo is unregistered", () => {
  const { resolver } = resolverFor(MAIN)
  const lookup: SessionGitLookup = {
    workspaceMetadataOf: () => ({ path: LINKED, branch: "chunky/widget-abc", parentSessionId: "parent" }),
    workspaceOf: () => MAIN,
    repoIdForPath: () => null,
  }
  // Every field is independently optional — an unregistered repo must not cost
  // the client the branch it could have grouped by.
  expect(sessionGitFields("child", LINKED, lookup, resolver)).toEqual({
    branch: "chunky/widget-abc",
    worktree: { path: LINKED, isLinked: true },
  })
})

// ---- summary fields: git fallback + degradation ----------------------------

test("a directory session falls back to git and omits `worktree` on the main checkout", async () => {
  const { resolver } = resolverFor(MAIN)
  const lookup: SessionGitLookup = { ...emptyLookup, repoIdForPath: (p) => (p === MAIN ? "rwidget" : null) }
  // Before git has answered the row renders flat — never an error, never a wait.
  expect(sessionGitFields("plain", MAIN, lookup, resolver)).toEqual({})
  await resolver.flush()
  expect(sessionGitFields("plain", MAIN, lookup, resolver)).toEqual({
    repoId: "rwidget",
    branch: "main",
  })
})

test("a session in a linked worktree resolved via git is marked linked", async () => {
  const { resolver } = resolverFor(LINKED)
  const lookup: SessionGitLookup = { ...emptyLookup, repoIdForPath: (p) => (p === MAIN ? "rwidget" : null) }
  expect(await settled(resolver, () => sessionGitFields("plain", LINKED, lookup, resolver))).toEqual({
    repoId: "rwidget",
    branch: "chunky/widget-abc",
    worktree: { path: LINKED, isLinked: true },
  })
})

test("repo identity is asked about git's canonical main path, not the queried spelling", async () => {
  // git reports realpath'd paths (/tmp -> /private/tmp on macOS). Callers must
  // therefore match the registry realpath-aware; this pins WHICH path they get
  // asked about, so a weaker lookup fails loudly here instead of silently
  // dropping `repoId` from every row.
  const { resolver } = resolverFor("/private/repos/widget")
  const asked: string[] = []
  const git = fakeGit({
    "rev-parse": "/private/repos/widget\n",
    worktree: [`worktree /private/repos/widget`, "HEAD 1111", "branch refs/heads/main", ""].join("\n"),
  })
  const canonical = new WorktreeResolver({ git: git.runner, exists: () => true })
  void resolver
  const fields = await settled(canonical, () => sessionGitFields("s", "/repos/widget", {
    ...emptyLookup,
    repoIdForPath: (path) => {
      asked.push(path)
      return null
    },
  }, canonical))
  expect(asked).toEqual(["/private/repos/widget"])
  expect(fields).toEqual({ branch: "main" })
})

test("no git, a detached HEAD and a throwing lookup all degrade to no fields", async () => {
  const noGit = new WorktreeResolver({ git: () => null, exists: () => true })
  expect(await settled(noGit, () => sessionGitFields("s", "/tmp/anything", emptyLookup, noGit))).toEqual({})

  const detached = new WorktreeResolver({
    git: (args) =>
      args[0] === "rev-parse"
        ? `${MAIN}\n`
        : [`worktree ${MAIN}`, "HEAD 1111111111111111111111111111111111111111", "detached", ""].join("\n"),
    exists: () => true,
  })
  // Detached: a repo id is still knowable, a branch is not.
  expect(
    await settled(detached, () => sessionGitFields("s", MAIN, { ...emptyLookup, repoIdForPath: () => "rwidget" }, detached)),
  ).toEqual({ repoId: "rwidget" })

  const throwing: SessionGitLookup = {
    workspaceMetadataOf: () => { throw new Error("db is gone") },
    workspaceOf: () => { throw new Error("db is gone") },
    repoIdForPath: () => { throw new Error("registry is gone") },
  }
  const { resolver } = resolverFor(MAIN)
  expect(await settled(resolver, () => sessionGitFields("s", MAIN, throwing, resolver))).toEqual({ branch: "main" })
})

test("malformed workspaces never throw", () => {
  const { resolver } = resolverFor(MAIN)
  for (const bad of ["", "\0", "  "]) {
    expect(() => sessionGitFields("s", bad, emptyLookup, resolver)).not.toThrow()
  }
})

// ---- Store.listByWorkspaces ------------------------------------------------

test("listByWorkspaces surfaces a worktree-fork session under its parent repo", () => {
  const repo = `/repo-${crypto.randomUUID()}`
  const worktree = `/worktree-${crypto.randomUUID()}`
  const parent = `wt-parent-${crypto.randomUUID()}`
  const child = `wt-child-${crypto.randomUUID()}`
  Store.createSession(parent, "Parent", repo)
  Store.forkSession(child, parent, worktree, "worktree", undefined, {
    gitCommonDir: `${repo}/.git`,
    branch: "chunky/child",
  })

  // The exact-match query every other caller still uses cannot see the child…
  expect(Store.list(repo).map((s) => s.sessionId)).toEqual([parent])
  // …but the repo's worktree set can, which is what puts it back in the tab.
  const ids = Store.listByWorkspaces([repo, worktree]).map((s) => s.sessionId)
  expect(ids).toContain(parent)
  expect(ids).toContain(child)
})

test("listByWorkspaces on an empty set returns nothing, never every session", () => {
  const repo = `/repo-${crypto.randomUUID()}`
  Store.createSession(`solo-${crypto.randomUUID()}`, "Solo", repo)
  expect(Store.listByWorkspaces([])).toEqual([])
  expect(Store.listByWorkspaces([""])).toEqual([])
  // A path nobody uses is empty, not a fallback to "all".
  expect(Store.listByWorkspaces([`/nothing-${crypto.randomUUID()}`])).toEqual([])
})

test("listByWorkspaces de-duplicates repeated paths", () => {
  const repo = `/repo-${crypto.randomUUID()}`
  const id = `dupe-${crypto.randomUUID()}`
  Store.createSession(id, "Dupe", repo)
  expect(Store.listByWorkspaces([repo, repo, repo]).filter((s) => s.sessionId === id)).toHaveLength(1)
})

// ---- real git, real worktree (end-to-end) ----------------------------------

function git(args: string[], cwd: string): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" })
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`)
}

test("a REAL linked worktree resolves end to end and lists under its repo", async () => {
  const root = join(tmpdir(), `chunky-worktree-test-${crypto.randomUUID()}`)
  dirs.push(root)
  const repo = join(root, "widget")
  mkdirSync(repo, { recursive: true })
  git(["init", "-b", "main"], repo)
  git(["config", "user.email", "test@example.com"], repo)
  git(["config", "user.name", "Test"], repo)
  writeFileSync(join(repo, "file.txt"), "hello")
  git(["add", "-A"], repo)
  git(["commit", "-m", "first"], repo)

  const linked = join(root, "widget-feature")
  git(["worktree", "add", "-b", "chunky/feature", linked, "HEAD"], repo)
  expect(existsSync(linked)).toBe(true)

  const resolver = new WorktreeResolver()
  // The real, asynchronous git runner: first reads schedule, nothing blocks.
  expect(resolver.resolve(repo)).toBeNull()
  expect(resolver.resolve(linked)).toBeNull()
  await resolver.flush()
  const fromRepo = resolver.resolve(repo)
  const fromLinked = resolver.resolve(linked)
  expect(fromRepo?.branch).toBe("main")
  expect(fromRepo?.linked).toBe(false)
  expect(fromLinked?.branch).toBe("chunky/feature")
  expect(fromLinked?.linked).toBe(true)
  // Both agree on which repository they belong to.
  expect(fromLinked?.mainPath).toBe(fromRepo?.mainPath ?? "")
  // git reports CANONICAL paths (on macOS /var is a symlink to /private/var),
  // while sessions are stored under whatever spelling the caller used. The set
  // must therefore be a superset of git's answer that also keeps the queried
  // spelling, or a repo whose path is reached through a symlink would show an
  // empty tab.
  const paths = resolver.worktreePathsFor(repo)
  for (const known of fromRepo?.worktrees ?? []) expect(paths).toContain(known)
  expect(paths).toContain(resolve(repo))
  expect(paths).toContain(fromLinked?.mainPath ?? "")

  // …and a session living in that worktree is listed under the repo's set.
  const parent = `real-parent-${crypto.randomUUID()}`
  const child = `real-child-${crypto.randomUUID()}`
  Store.createSession(parent, "Parent", fromRepo!.mainPath)
  Store.forkSession(child, parent, linked, "worktree", undefined, {
    gitCommonDir: join(repo, ".git"),
    branch: "chunky/feature",
  })
  // The fork stored the path it created; git reports the canonicalized one. The
  // repo's workspace set unions both, so the child cannot fall out of the tab.
  const workspaces = repoWorkspaceSet(repo, (paths) => Store.worktreeWorkspacesUnder(paths), resolver)
  const listed = Store.listByWorkspaces(workspaces).map((s) => s.sessionId)
  expect(listed).toContain(parent)
  expect(listed).toContain(child)

  // The summary fields a client would receive for that row.
  const lookup: SessionGitLookup = {
    workspaceMetadataOf: (id) => Store.workspaceMetadataOf(id),
    workspaceOf: (id) => Store.workspaceOf(id),
    repoIdForPath: (path) => (resolve(path) === resolve(fromRepo!.mainPath) ? "rwidget" : null),
  }
  expect(sessionGitFields(child, linked, lookup, resolver)).toEqual({
    repoId: "rwidget",
    branch: "chunky/feature",
    worktree: { path: resolve(linked), isLinked: true },
  })
})
