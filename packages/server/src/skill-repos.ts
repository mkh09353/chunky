// Managed skill repositories: git clones under the server state dir whose
// SKILL.md packages are discovered alongside user/project skills.
//
// Registry lives in settings.json (`skillRepos`). Working trees live next to
// settings under `skill-repos/<id>/`. Mutations go through manageSkillRepos so
// HTTP, TUI, and the agent tool share one path.
import { existsSync, mkdirSync, rmSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { spawn } from "node:child_process"
import {
  addSkillRepo,
  listSkillRepos,
  removeSkillRepo,
  skillRepoById,
  skillReposRoot,
  updateSkillRepo,
  type SkillRepoRecord,
} from "./settings.ts"

export type SkillRepoAction = "add" | "remove" | "update" | "list"

export interface SkillRepoStatus extends SkillRepoRecord {
  /** Absolute path of the local clone (may not exist yet / after failed add). */
  path: string
  /** Whether the local tree currently exists. */
  present: boolean
}

function stateDir(): string {
  const settings = process.env.CHUNKY_SETTINGS
  if (settings) return dirname(resolve(settings))
  return resolve(".")
}

/** Absolute path of a managed repo's working tree. */
export function skillRepoPath(id: string): string {
  return join(skillReposRoot(stateDir()), id)
}

/** All registered managed repos with filesystem status. */
export function listSkillRepoStatus(): SkillRepoStatus[] {
  return listSkillRepos().map((repo) => {
    const path = skillRepoPath(repo.id)
    return { ...repo, path, present: existsSync(path) }
  })
}

/** Absolute roots to scan for SKILL.md during discovery (existing clones only). */
export function managedSkillRoots(): Array<{ root: string; label: string; id: string }> {
  return listSkillRepos()
    .map((repo) => {
      const root = skillRepoPath(repo.id)
      return { root, label: `repo:${repo.id}`, id: repo.id, present: existsSync(root) }
    })
    .filter((r) => r.present)
    .map(({ root, label, id }) => ({ root, label, id }))
}

// ── URL / id helpers ─────────────────────────────────────────────────────────

const REMOTE_URL_RE = /^(https:\/\/|git@|ssh:\/\/git@)[^\s]+$/i
const FILE_URL_RE = /^file:\/\/\/[^\s]+$/i

/** Reject obviously unsafe or non-git URLs.
 *  Allowed: https://, git@, ssh://git@ remotes; absolute local paths / file://
 *  (for offline / self-hosted skill packs). Relative paths are rejected. */
export function validateSkillRepoUrl(url: string): string {
  const trimmed = url.trim()
  if (!trimmed) throw new Error("url is required")
  if (/\s/.test(trimmed)) throw new Error("url cannot contain whitespace")
  if (REMOTE_URL_RE.test(trimmed)) return trimmed
  if (FILE_URL_RE.test(trimmed)) return trimmed
  // Absolute local path (posix or windows drive)
  if (trimmed.startsWith("/") || /^[A-Za-z]:[\\/]/.test(trimmed)) {
    if (trimmed.includes("\0")) throw new Error("url contains null bytes")
    return trimmed
  }
  throw new Error(
    "url must be an https://, git@, ssh://git@ remote, file:// URL, or absolute local path",
  )
}

/** Derive a stable filesystem-safe id from a git URL. */
export function skillRepoIdFromUrl(url: string): string {
  let s = url.trim().replace(/\.git$/i, "")
  // git@host:owner/repo → host/owner/repo
  const scp = s.match(/^git@([^:]+):(.+)$/)
  if (scp) s = `${scp[1]}/${scp[2]}`
  // ssh://git@host/owner/repo
  s = s.replace(/^ssh:\/\/git@/i, "")
  s = s.replace(/^https?:\/\//i, "")
  // Drop credentials if present
  s = s.replace(/^[^@]+@/, "")
  // Sanitize
  let id = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  if (!id) id = "skill-repo"
  if (id.length > 80) id = id.slice(0, 80).replace(/-+$/g, "")
  return id
}

export function validateSkillRepoId(id: string | undefined): string {
  const v = id?.trim()
  if (!v) throw new Error("id is required")
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/i.test(v)) {
    throw new Error("id must be alphanumeric with single hyphens (e.g. github-com-owner-repo)")
  }
  if (v.length > 80) throw new Error("id is too long (max 80)")
  return v.toLowerCase()
}

// ── git subprocess ───────────────────────────────────────────────────────────

function runGit(args: string[], cwd?: string, timeoutMs = 120_000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: {
        ...process.env,
        // Avoid interactive prompts hanging the server.
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "echo",
      },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      reject(new Error(`git ${args[0]} timed out after ${timeoutMs / 1000}s`))
    }, timeoutMs)
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString()
    })
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString()
    })
    child.on("error", (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      if (code === 0) resolvePromise({ stdout, stderr })
      else {
        const msg = (stderr || stdout || `git exited ${code}`).trim().slice(0, 500)
        reject(new Error(msg))
      }
    })
  })
}

async function cloneRepo(url: string, dest: string, branch?: string): Promise<void> {
  mkdirSync(dirname(dest), { recursive: true })
  if (existsSync(dest)) {
    throw new Error(`clone path already exists: ${dest}`)
  }
  const args = ["clone", "--depth", "1", "--single-branch"]
  if (branch) args.push("--branch", branch)
  args.push(url, dest)
  await runGit(args)
}

async function pullRepo(dest: string, branch?: string): Promise<void> {
  if (!existsSync(join(dest, ".git"))) {
    throw new Error(`not a git clone: ${dest}`)
  }
  // Fetch + hard reset to origin keeps managed trees clean (no local edits expected).
  await runGit(["fetch", "--depth", "1", "origin"], dest)
  let ref = "origin/HEAD"
  if (branch) {
    ref = `origin/${branch}`
  } else {
    try {
      const { stdout } = await runGit(["symbolic-ref", "refs/remotes/origin/HEAD"], dest)
      const m = stdout.trim().match(/refs\/remotes\/origin\/(.+)/)
      if (m) ref = `origin/${m[1]}`
    } catch {
      // Fall back to origin/HEAD; reset may still work.
    }
  }
  await runGit(["checkout", "-f", "--detach", ref], dest)
  // Also update default branch tip for cleanliness when branch was given.
  if (branch) {
    try {
      await runGit(["branch", "-f", branch, ref], dest)
    } catch {
      /* optional */
    }
  }
}

// ── Public mutation API ──────────────────────────────────────────────────────

export async function addManagedSkillRepo(opts: {
  url: string
  branch?: string
  id?: string
}): Promise<SkillRepoStatus> {
  const url = validateSkillRepoUrl(opts.url)
  const id = opts.id ? validateSkillRepoId(opts.id) : skillRepoIdFromUrl(url)
  const branch = opts.branch?.trim() || undefined
  if (branch && /[^\w./-]+/.test(branch)) {
    throw new Error("branch contains invalid characters")
  }

  if (skillRepoById(id)) {
    throw new Error(`skill repo "${id}" is already registered (use update to refresh, or remove first)`)
  }

  const path = skillRepoPath(id)
  // Stale directory without a registry entry — remove so clone can proceed.
  if (existsSync(path)) {
    rmSync(path, { recursive: true, force: true })
  }

  try {
    await cloneRepo(url, path, branch)
  } catch (err) {
    // Clean partial clone
    try {
      if (existsSync(path)) rmSync(path, { recursive: true, force: true })
    } catch {
      /* ok */
    }
    throw new Error(`clone failed: ${(err as Error).message}`)
  }

  const record = addSkillRepo({
    id,
    url,
    ...(branch ? { branch } : {}),
    addedAt: Date.now(),
    lastSync: Date.now(),
  })
  return { ...record, path, present: true }
}

export async function removeManagedSkillRepo(idOrUrl: string): Promise<{ id: string; removed: boolean }> {
  const key = idOrUrl.trim()
  if (!key) throw new Error("id or url is required")

  let id = key
  const byId = skillRepoById(key)
  if (!byId) {
    // Allow remove by URL
    const match = listSkillRepos().find((r) => r.url === key || r.id === skillRepoIdFromUrl(key))
    if (!match) throw new Error(`skill repo "${key}" not found`)
    id = match.id
  } else {
    id = byId.id
  }

  const path = skillRepoPath(id)
  if (existsSync(path)) {
    rmSync(path, { recursive: true, force: true })
  }
  const removed = removeSkillRepo(id)
  return { id, removed }
}

export async function updateManagedSkillRepo(id?: string): Promise<SkillRepoStatus[]> {
  const targets = id
    ? (() => {
        const r = skillRepoById(id.trim())
        if (!r) throw new Error(`skill repo "${id}" not found`)
        return [r]
      })()
    : listSkillRepos()

  if (targets.length === 0) return []

  const results: SkillRepoStatus[] = []
  for (const repo of targets) {
    const path = skillRepoPath(repo.id)
    try {
      if (!existsSync(path)) {
        await cloneRepo(repo.url, path, repo.branch)
      } else {
        await pullRepo(path, repo.branch)
      }
      const next = updateSkillRepo(repo.id, { lastSync: Date.now(), lastError: undefined })
      results.push({ ...(next ?? repo), path, present: true })
    } catch (err) {
      const msg = (err as Error).message
      const next = updateSkillRepo(repo.id, { lastError: msg })
      results.push({
        ...(next ?? repo),
        path,
        present: existsSync(path),
        lastError: msg,
      })
    }
  }
  return results
}

/** Shared mutation path for HTTP, TUI, and the agent tool. */
export async function manageSkillRepos(
  action: SkillRepoAction,
  opts: { url?: string; id?: string; branch?: string } = {},
): Promise<unknown> {
  if (action === "list") {
    return { action, repos: listSkillRepoStatus() }
  }
  if (action === "add") {
    if (!opts.url) throw new Error("url is required for add")
    const repo = await addManagedSkillRepo({
      url: opts.url,
      branch: opts.branch,
      id: opts.id,
    })
    return { action, repo }
  }
  if (action === "remove") {
    const key = opts.id || opts.url
    if (!key) throw new Error("id (or url) is required for remove")
    const result = await removeManagedSkillRepo(key)
    return { action, ...result }
  }
  if (action === "update") {
    const repos = await updateManagedSkillRepo(opts.id)
    const failed = repos.filter((r) => r.lastError)
    return {
      action,
      updated: repos.length,
      failed: failed.length,
      repos,
    }
  }
  throw new Error(`unknown action "${action as string}"`)
}
