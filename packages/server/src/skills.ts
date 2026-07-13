// Lazy on-demand Agent Skills discovery (SKILL.md convention).
//
// Skills are NOT injected into the system prompt. The model only sees permanent
// `search_skills` / `load_skill` tools; skill bodies arrive as tool output when
// explicitly loaded. Default behavior never auto-loads.
//
// Locations (user → managed repos → project; project wins on name collision):
//   User:     ~/.chunky/skills, ~/.agents/skills, ~/.claude/skills, ~/.codex/skills
//   Managed:  skill-repos/<id>/ clones registered via /skills or manage_skill_repos
//   Project:  .chunky/skills, .agents/skills, .claude/skills, .codex/skills
//             (workspace + ancestors up to git root / filesystem root)
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join, resolve, sep } from "node:path"
import { managedSkillRoots } from "./skill-repos.ts"
import { MAX_BYTES, MAX_LINES, truncateOutput } from "./tools/fs-util.ts"

const MAX_NAME_LENGTH = 64
const MAX_DESCRIPTION_LENGTH = 1024
const SKILL_FILENAME = "SKILL.md"

/** Relative skill roots under home (user) and under each project ancestor. */
const USER_SKILL_ROOTS = [
  ".chunky/skills",
  ".agents/skills",
  ".claude/skills",
  ".codex/skills",
] as const

const PROJECT_SKILL_ROOTS = [
  ".chunky/skills",
  ".agents/skills",
  ".claude/skills",
  ".codex/skills",
] as const

export type SkillSource = "user" | "project" | "repo"

export interface SkillMeta {
  name: string
  description: string
  /** Absolute path to SKILL.md. */
  path: string
  /** Directory containing SKILL.md (for relative asset resolution). */
  baseDir: string
  source: SkillSource
  /** Human label for the root, e.g. "~/.claude/skills", ".agents/skills", or "repo:id". */
  sourceLabel: string
}

export interface LoadedSkill {
  name: string
  description: string
  path: string
  baseDir: string
  source: SkillSource
  sourceLabel: string
  body: string
  /** True when this session/thread already loaded the skill earlier (body still re-emitted). */
  alreadyLoaded: boolean
  truncated: boolean
}

export interface SkillFrontmatter {
  name?: string
  description?: string
  [key: string]: unknown
}

// ── Frontmatter (no yaml dep — only name/description matter) ─────────────────

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
}

/** Split a SKILL.md into simple frontmatter fields + body. */
export function parseSkillMarkdown(content: string): {
  frontmatter: SkillFrontmatter
  body: string
} {
  const normalized = normalizeNewlines(content)
  if (!normalized.startsWith("---")) {
    return { frontmatter: {}, body: normalized.trim() }
  }
  const end = normalized.indexOf("\n---", 3)
  if (end === -1) {
    return { frontmatter: {}, body: normalized.trim() }
  }
  const yamlString = normalized.slice(4, end)
  // `end` is the index of `\n---` that closes the frontmatter; body starts after those 4 chars.
  let body = normalized.slice(end + 4)
  if (body.startsWith("\n")) body = body.slice(1)
  return { frontmatter: parseSimpleYaml(yamlString), body: body.trim() }
}

/**
 * Minimal YAML subset for skill frontmatter: `key: value`, quoted values,
 * and folded (`>`) / literal (`|`) multiline blocks. Unknown structure is ignored.
 */
function parseSimpleYaml(yaml: string): SkillFrontmatter {
  const out: SkillFrontmatter = {}
  const lines = yaml.split("\n")
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const m = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/)
    if (!m) {
      i++
      continue
    }
    const key = m[1]
    let raw = m[2]
    if (raw === ">" || raw === "|" || raw === ">-" || raw === "|-") {
      const block: string[] = []
      i++
      while (i < lines.length) {
        const next = lines[i]
        if (next.length === 0) {
          block.push("")
          i++
          continue
        }
        if (/^\s/.test(next)) {
          block.push(next.replace(/^\s+/, ""))
          i++
          continue
        }
        break
      }
      out[key] = block.join(raw.startsWith(">") ? " " : "\n").trim()
      continue
    }
    // Strip surrounding quotes.
    if (
      (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) ||
      (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2)
    ) {
      raw = raw.slice(1, -1)
    }
    out[key] = raw.trim()
    i++
  }
  return out
}

function isValidName(name: string): boolean {
  if (!name || name.length > MAX_NAME_LENGTH) return false
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) return false
  return true
}

// ── Filesystem discovery ─────────────────────────────────────────────────────

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

function realPath(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return resolve(p)
  }
}

/** Walk ancestors of `start` until git root (dir with .git) or filesystem root. */
export function projectAncestors(start: string): string[] {
  const out: string[] = []
  let cur = resolve(start)
  const seen = new Set<string>()
  while (!seen.has(cur)) {
    seen.add(cur)
    out.push(cur)
    if (existsSync(join(cur, ".git"))) break
    const parent = dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  return out
}

/**
 * Recursively find SKILL.md files under `root`. A directory that itself contains
 * SKILL.md is a skill leaf (no deeper scan). Skips dotdirs and node_modules.
 */
export function findSkillFiles(root: string): string[] {
  const found: string[] = []
  if (!isDir(root)) return found

  const walk = (dir: string, depth: number) => {
    if (depth > 8) return
    let entries: import("node:fs").Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    const skillHere = entries.find((e) => e.name === SKILL_FILENAME)
    if (skillHere) {
      const full = join(dir, SKILL_FILENAME)
      if (isFile(full)) {
        found.push(full)
        return // skill root — don't recurse
      }
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue
      if (entry.name === "node_modules") continue
      const full = join(dir, entry.name)
      let isDirectory = entry.isDirectory()
      if (entry.isSymbolicLink()) {
        try {
          isDirectory = statSync(full).isDirectory()
        } catch {
          continue
        }
      }
      if (isDirectory) walk(full, depth + 1)
    }
  }

  walk(root, 0)
  return found
}

function loadMetaFromFile(
  filePath: string,
  source: SkillSource,
  sourceLabel: string,
): SkillMeta | null {
  let raw: string
  try {
    raw = readFileSync(filePath, "utf-8")
  } catch {
    return null
  }
  const { frontmatter } = parseSkillMarkdown(raw)
  const parentName = basename(dirname(filePath))
  const nameRaw = typeof frontmatter.name === "string" && frontmatter.name.trim()
    ? frontmatter.name.trim()
    : parentName
  const description =
    typeof frontmatter.description === "string" ? frontmatter.description.trim() : ""
  if (!description) return null
  // Prefer a valid name; fall back to parent dir even if slightly non-spec so
  // shared skill dirs still work (same leniency as Pi).
  const name = isValidName(nameRaw) ? nameRaw : isValidName(parentName) ? parentName : nameRaw
  if (!name) return null
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    // Still load; truncate description for search listings.
  }
  return {
    name,
    description: description.slice(0, MAX_DESCRIPTION_LENGTH),
    path: resolve(filePath),
    baseDir: dirname(resolve(filePath)),
    source,
    sourceLabel,
  }
}

function homeLabel(rel: string): string {
  return `~/${rel.split(sep).join("/")}`
}

/**
 * Discover all skills for a workspace. Project skills override user skills of
 * the same name. Within a scope, the first path found wins (stable scan order).
 */
export function discoverSkills(workspace: string): SkillMeta[] {
  const byName = new Map<string, SkillMeta>()
  const seenReal = new Set<string>()

  const add = (meta: SkillMeta | null, overwrite: boolean) => {
    if (!meta) return
    const real = realPath(meta.path)
    if (seenReal.has(real)) return
    const existing = byName.get(meta.name)
    if (existing && !overwrite) return
    // If overwriting, drop the previous real path so a later identical path can re-add.
    if (existing) {
      seenReal.delete(realPath(existing.path))
    }
    byName.set(meta.name, meta)
    seenReal.add(real)
  }

  const home = homedir()
  for (const rel of USER_SKILL_ROOTS) {
    const root = join(home, rel)
    const label = homeLabel(rel)
    for (const file of findSkillFiles(root)) {
      add(loadMetaFromFile(file, "user", label), false)
    }
  }

  // Managed skill git repos: after user skills, before project (project wins).
  for (const { root, label } of managedSkillRoots()) {
    for (const file of findSkillFiles(root)) {
      add(loadMetaFromFile(file, "repo", label), true)
    }
  }

  // Project: walk workspace → root; nearer (workspace-first) wins over farther.
  // Scan farthest first so nearer overwrites.
  const ancestors = projectAncestors(workspace)
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const dir = ancestors[i]
    for (const rel of PROJECT_SKILL_ROOTS) {
      const root = join(dir, rel)
      // Label relative to workspace when under it; else basename of root.
      const label = rel
      for (const file of findSkillFiles(root)) {
        add(loadMetaFromFile(file, "project", label), true)
      }
    }
  }

  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name))
}

/** Case-insensitive substring match over name + description. Empty query → all. */
export function searchSkills(workspace: string, query?: string): SkillMeta[] {
  const all = discoverSkills(workspace)
  const q = (query ?? "").trim().toLowerCase()
  if (!q) return all
  const tokens = q.split(/\s+/).filter(Boolean)
  return all.filter((s) => {
    const hay = `${s.name} ${s.description} ${s.sourceLabel}`.toLowerCase()
    return tokens.every((t) => hay.includes(t))
  })
}

// ── Load ─────────────────────────────────────────────────────────────────────

/**
 * Resolve a skill by name (or unique prefix) against the current workspace catalog.
 */
export function resolveSkill(workspace: string, nameOrPrefix: string): SkillMeta | { error: string } {
  const q = nameOrPrefix.trim()
  if (!q) return { error: "skill name is required" }
  const all = discoverSkills(workspace)
  const exact = all.find((s) => s.name === q)
  if (exact) return exact
  // Case-insensitive exact
  const ci = all.find((s) => s.name.toLowerCase() === q.toLowerCase())
  if (ci) return ci
  const prefix = all.filter((s) => s.name.startsWith(q) || s.name.toLowerCase().startsWith(q.toLowerCase()))
  if (prefix.length === 1) return prefix[0]
  if (prefix.length > 1) {
    return {
      error: `ambiguous skill "${q}" — matches: ${prefix.map((s) => s.name).join(", ")}. Use the full name.`,
    }
  }
  const available = all.length ? all.map((s) => s.name).join(", ") : "none"
  return { error: `skill "${q}" not found. Available: ${available}. Call search_skills to browse.` }
}

/**
 * Load a skill's body for tool output. Always re-emits the full body on every
 * call (including repeats). A process-global short notice is unsafe after
 * summarization/compaction drops the earlier tool output — re-emitting keeps
 * the model able to re-acquire instructions. No process-global state is kept,
 * avoiding cross-session leakage and lifecycle cleanup requirements.
 */
export function loadSkill(
  workspace: string,
  name: string,
  _scopeKey: string,
): LoadedSkill | { error: string } {
  const resolved = resolveSkill(workspace, name)
  if ("error" in resolved) return resolved

  let raw: string
  try {
    raw = readFileSync(resolved.path, "utf-8")
  } catch (err) {
    return { error: `failed to read skill "${resolved.name}": ${(err as Error).message}` }
  }
  const { body } = parseSkillMarkdown(raw)
  const { content, truncated } = truncateOutput(body || raw, { keep: "head" })
  return {
    name: resolved.name,
    description: resolved.description,
    path: resolved.path,
    baseDir: resolved.baseDir,
    source: resolved.source,
    sourceLabel: resolved.sourceLabel,
    body: content,
    alreadyLoaded: false,
    truncated,
  }
}

/** Format search results for the model (metadata only — no bodies). */
export function formatSearchResults(skills: SkillMeta[], query?: string): string {
  if (skills.length === 0) {
    const q = (query ?? "").trim()
    return q
      ? `No skills matching "${q}". Try a broader query or call search_skills with no query to list all.`
      : "No skills discovered. Install Agent Skills under ~/.chunky/skills, ~/.agents/skills, ~/.claude/skills, project .agents/skills / .claude/skills / .chunky/skills, or add a managed skill repo via manage_skill_repos / /skills add <git-url> (each skill is a dir with SKILL.md)."
  }
  const lines = skills.map((s) => {
    const desc = s.description.replace(/\s+/g, " ").trim()
    return `- ${s.name} (${s.source}:${s.sourceLabel})\n  ${desc}`
  })
  const header = (query ?? "").trim()
    ? `Skills matching "${query!.trim()}" (${skills.length}):`
    : `Available skills (${skills.length}):`
  return (
    `${header}\n${lines.join("\n")}\n\n` +
    "Use load_skill with a skill name to load its full instructions into this turn's tool output. " +
    "Skills are not auto-loaded."
  )
}

/** Format a successful load for tool output. Always includes the body. */
export function formatLoadResult(loaded: LoadedSkill): string {
  const parts = [
    `## Skill: ${loaded.name}`,
    "",
    `**Description**: ${loaded.description}`,
    `**Source**: ${loaded.source} (${loaded.sourceLabel})`,
    `**Path**: ${loaded.path}`,
    `**Base directory**: ${loaded.baseDir}`,
    "",
    "When this skill references relative paths, resolve them against the base directory above.",
    "",
    loaded.body || "(empty skill body)",
  ]
  let out = parts.join("\n")
  if (loaded.truncated) {
    out += `\n\n[Skill body truncated to ~${MAX_LINES} lines / ${MAX_BYTES / 1000}KB. Read the file at ${loaded.path} for the rest.]`
  }
  return out
}
