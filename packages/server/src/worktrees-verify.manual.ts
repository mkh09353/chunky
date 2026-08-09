// Manual verification: a REAL `/fork --worktree` child must appear under its
// parent repo, carrying branch + worktree + repoId, through the exact code path
// GET /api/sessions uses. Runs against an isolated CHUNKY_HOME/CHUNKY_DB.
import { mkdirSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { join, resolve } from "node:path"

const ROOT = process.env.VERIFY_ROOT!
const repo = join(ROOT, "widget")

function git(args: string[], cwd: string) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" })
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`)
  return r.stdout.trim()
}

mkdirSync(repo, { recursive: true })
git(["init", "-b", "main"], repo)
git(["config", "user.email", "v@example.com"], repo)
git(["config", "user.name", "V"], repo)
writeFileSync(join(repo, "README.md"), "hi")
git(["add", "-A"], repo)
git(["commit", "-m", "init"], repo)

// Real modules, imported AFTER the env is set by the caller.
const { addRepo, listRepos } = await import("./repos.ts")
const { Store } = await import("./store.ts")
const { createForkWorktree } = await import("./worktree-fork.ts")
const { repoWorkspaceSet, sessionGitFields } = await import("./worktrees.ts")
const { canonicalWorkspace } = await import("./launcher-discovery.ts")

const registered = addRepo(repo)
console.log(`registered repo: id=${registered.id} path=${registered.path}`)

const parent = `verify-parent-${crypto.randomUUID()}`
Store.createSession(parent, "Parent thread", registered.path)

// Exactly what POST /api/sessions/:id/fork {worktree:true} does.
const child = crypto.randomUUID()
const created = createForkWorktree(registered.path, child, () => true)
if (!created) throw new Error("createForkWorktree failed")
Store.forkSession(child, parent, created.path, "worktree", undefined, {
  gitCommonDir: created.gitCommonDir,
  branch: created.branch,
})
console.log(`forked worktree: branch=${created.branch}`)
console.log(`         stored workspace=${created.path}`)
console.log(`  git canonical worktrees=${JSON.stringify(git(["worktree", "list", "--porcelain"], repo).split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice(9)))}`)

// ---- the listSessions code path -------------------------------------------
const lookup = {
  workspaceMetadataOf: (id: string) => Store.workspaceMetadataOf(id),
  workspaceOf: (id: string) => Store.workspaceOf(id),
  // MUST mirror index.ts exactly: git reports canonical (realpath'd) paths, so a
  // plain resolve() here silently fails to match a registry entry reached
  // through a symlink (/tmp -> /private/tmp on macOS).
  repoIdForPath: (path: string) => {
    const target = canonicalWorkspace(path)
    return listRepos().repos.find((r) => canonicalWorkspace(r.path) === target)?.id ?? null
  },
}
const workspaces = repoWorkspaceSet(registered.path, (paths) => Store.worktreeWorkspacesUnder(paths))
console.log(`\nrepoWorkspaceSet -> ${JSON.stringify(workspaces, null, 2)}`)

const rows = Store.listByWorkspaces(workspaces).map((s) => ({
  ...s,
  ...sessionGitFields(s.sessionId, s.workspace ?? "", lookup),
}))

console.log(`\n--- GET /api/sessions?repo=${registered.id} would return ---`)
for (const row of rows) {
  console.log(JSON.stringify({
    sessionId: row.sessionId.slice(0, 18),
    title: row.title,
    workspace: row.workspace,
    repoId: row.repoId,
    branch: row.branch,
    worktree: row.worktree,
  }, null, 2))
}

// ---- assertions ------------------------------------------------------------
const childRow = rows.find((r) => r.sessionId === child)
const parentRow = rows.find((r) => r.sessionId === parent)
const problems: string[] = []
if (!parentRow) problems.push("parent session missing from repo listing")
if (!childRow) problems.push("WORKTREE-FORK CHILD MISSING from repo listing")
if (childRow?.branch !== created.branch) problems.push(`child branch=${childRow?.branch} expected ${created.branch}`)
if (childRow?.worktree?.isLinked !== true) problems.push("child not flagged as a linked worktree")
if (childRow?.repoId !== registered.id) problems.push(`child repoId=${childRow?.repoId} expected ${registered.id}`)
if (parentRow?.branch !== "main") problems.push(`parent branch=${parentRow?.branch} expected main`)
if (parentRow?.repoId !== registered.id) problems.push(`parent repoId=${parentRow?.repoId} expected ${registered.id}`)
if (parentRow?.worktree) problems.push("parent must NOT be flagged as a linked worktree")

console.log(problems.length === 0 ? "\nVERIFIED: all assertions passed" : `\nFAILED:\n - ${problems.join("\n - ")}`)
process.exit(problems.length === 0 ? 0 : 1)
