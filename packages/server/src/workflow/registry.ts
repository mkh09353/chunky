// Saved/named workflows. Project `.chunky/workflows/*.workflow.js` wins over
// user `~/.chunky/workflows/*.workflow.js` on the same kebab-case name.
// Scan is on-demand (no cache). Malformed files are skipped with a warning.
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { stripExports } from "./runtime.ts"

export const WORKFLOW_FILE_SUFFIX = ".workflow.js"
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const MAX_NAME = 64

export interface SavedWorkflowMeta {
  name: string
  description?: string
  when_to_use?: string
}

export interface SavedWorkflow {
  name: string
  description?: string
  when_to_use?: string
  script: string
  path: string
  source: "project" | "user"
}

export function isValidWorkflowName(name: string): boolean {
  return name.length > 0 && name.length <= MAX_NAME && NAME_RE.test(name)
}

export function filenameToWorkflowName(filename: string): string | undefined {
  if (!filename.endsWith(WORKFLOW_FILE_SUFFIX)) return undefined
  const stem = filename.slice(0, -WORKFLOW_FILE_SUFFIX.length)
  return isValidWorkflowName(stem) ? stem : undefined
}

export function userWorkflowsDir(home = process.env.CHUNKY_HOME || join(homedir(), ".chunky")): string {
  return join(home, "workflows")
}

export function projectWorkflowsDir(workspace: string): string {
  return join(workspace, ".chunky", "workflows")
}

/** Parse `export const meta = {…}` or a leading `/* … *\/` / `//` JSON-ish block.
 *  Missing/invalid meta is not fatal — the caller falls back to the filename. */
export function parseWorkflowMeta(script: string): Partial<SavedWorkflowMeta> {
  return parseExportMeta(script) ?? parseLeadingCommentMeta(script) ?? {}
}

function parseExportMeta(script: string): Partial<SavedWorkflowMeta> | undefined {
  const body = stripExports(script)
  const match = body.match(/^\s*(?:const|let|var)\s+meta\s*=\s*(\{[\s\S]*?\})\s*;?/m)
  if (!match) return undefined
  return parseMetaObjectLiteral(match[1]!)
}

function parseLeadingCommentMeta(script: string): Partial<SavedWorkflowMeta> | undefined {
  const trimmed = script.trimStart()
  if (trimmed.startsWith("/*")) {
    const end = trimmed.indexOf("*/")
    if (end < 0) return undefined
    return parseMetaObjectLiteral(trimmed.slice(2, end))
  }
  if (trimmed.startsWith("//")) {
    const lines: string[] = []
    for (const line of trimmed.split(/\r?\n/)) {
      if (!line.startsWith("//")) break
      lines.push(line.replace(/^\/\/\s?/, ""))
    }
    return parseMetaObjectLiteral(lines.join("\n"))
  }
  return undefined
}

function parseMetaObjectLiteral(raw: string): Partial<SavedWorkflowMeta> | undefined {
  const text = raw.trim()
  if (!text) return undefined
  const jsonish = text.startsWith("{") ? text : `{${text}}`
  try {
    const parsed = JSON.parse(jsonish) as Record<string, unknown>
    return pickMeta(parsed)
  } catch {
    // Allow a light JS object literal: unquoted keys and single quotes.
    try {
      const normalized = jsonish
        .replace(/'/g, '"')
        .replace(/([,{]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":')
      return pickMeta(JSON.parse(normalized) as Record<string, unknown>)
    } catch {
      return undefined
    }
  }
}

function pickMeta(parsed: Record<string, unknown>): Partial<SavedWorkflowMeta> {
  const meta: Partial<SavedWorkflowMeta> = {}
  if (typeof parsed.name === "string") meta.name = parsed.name
  if (typeof parsed.description === "string") meta.description = parsed.description
  if (typeof parsed.when_to_use === "string") meta.when_to_use = parsed.when_to_use
  return meta
}

export interface ScanOptions {
  workspace?: string
  userDir?: string
  warn?: (message: string) => void
}

export function scanSavedWorkflows(opts: ScanOptions = {}): SavedWorkflow[] {
  const warn = opts.warn ?? ((message: string) => console.warn(message))
  const byName = new Map<string, SavedWorkflow>()
  const userDir = opts.userDir ?? userWorkflowsDir()
  loadDir(userDir, "user", byName, warn)
  if (opts.workspace) loadDir(projectWorkflowsDir(opts.workspace), "project", byName, warn)
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

function loadDir(
  dir: string,
  source: "project" | "user",
  byName: Map<string, SavedWorkflow>,
  warn: (message: string) => void,
): void {
  if (!existsSync(dir)) return
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch (err) {
    warn(`skipping workflow dir ${dir}: ${(err as Error).message}`)
    return
  }
  for (const filename of names.sort()) {
    if (!filename.endsWith(WORKFLOW_FILE_SUFFIX) || filename.startsWith(".")) continue
    const path = join(dir, filename)
    let script: string
    try {
      script = readFileSync(path, "utf8")
    } catch (err) {
      warn(`skipping workflow ${path}: ${(err as Error).message}`)
      continue
    }
    const fallback = filenameToWorkflowName(filename)
    const meta = parseWorkflowMeta(script)
    const name = meta.name ?? fallback
    if (!name || !isValidWorkflowName(name)) {
      warn(`skipping workflow ${path}: invalid or missing kebab-case name`)
      continue
    }
    if (source === "user" && byName.has(name)) continue
    byName.set(name, {
      name,
      description: meta.description,
      when_to_use: meta.when_to_use,
      script,
      path,
      source,
    })
  }
}

export function resolveSavedWorkflow(name: string, opts: ScanOptions = {}): SavedWorkflow | undefined {
  if (!isValidWorkflowName(name)) return undefined
  return scanSavedWorkflows(opts).find((entry) => entry.name === name)
}

export function formatAvailableWorkflows(entries: SavedWorkflow[]): string {
  if (!entries.length) return "(none)"
  return entries.map((entry) => `${entry.name} (${entry.source})`).join(", ")
}
