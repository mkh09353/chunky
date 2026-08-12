import { readFile } from "node:fs/promises"
import { basename, resolve } from "node:path"
import { stateDir } from "./repos.ts"

export type PapercutEntry = {
  timestamp: string
  model: string
  sessionId: string
  workspace: string
  text: string
  category?: "tooling" | "docs" | "env" | "flaky" | "other"
}

export type PapercutsOptions = { since?: number; workspace?: string; json: boolean }
export type ParsedPapercut = { entry: PapercutEntry; raw: string }

export function parseSince(value: string, now = Date.now()): number {
  const match = /^(\d+)([hd])$/.exec(value)
  if (!match) throw new Error(`invalid --since value ${JSON.stringify(value)} (use e.g. 7d or 24h)`)
  const amount = Number(match[1])
  return now - amount * (match[2] === "d" ? 86_400_000 : 3_600_000)
}

export function parsePapercutsArgs(args: string[], now = Date.now()): PapercutsOptions {
  const options: PapercutsOptions = { json: false }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === "--json") options.json = true
    else if (arg === "--since") {
      if (!args[i + 1]) throw new Error("--since requires a value")
      options.since = parseSince(args[++i]!, now)
    } else if (arg === "--workspace") {
      if (!args[i + 1]) throw new Error("--workspace requires a path")
      options.workspace = resolve(args[++i]!)
    } else throw new Error(`unknown papercuts option: ${arg}`)
  }
  return options
}

export function parsePapercutLines(contents: string): ParsedPapercut[] {
  const parsed: ParsedPapercut[] = []
  for (const raw of contents.split(/\r?\n/)) {
    if (!raw.trim()) continue
    try {
      const entry = JSON.parse(raw) as PapercutEntry
      if (typeof entry.timestamp !== "string" || typeof entry.model !== "string" || typeof entry.workspace !== "string" || typeof entry.text !== "string") continue
      if (!Number.isFinite(Date.parse(entry.timestamp))) continue
      parsed.push({ entry, raw })
    } catch { /* Skip malformed complaint lines without hiding valid neighbors. */ }
  }
  return parsed.sort((a, b) => Date.parse(a.entry.timestamp) - Date.parse(b.entry.timestamp))
}

export function filterPapercuts(entries: ParsedPapercut[], options: PapercutsOptions): ParsedPapercut[] {
  return entries.filter(({ entry }) =>
    (options.since === undefined || Date.parse(entry.timestamp) >= options.since)
    && (options.workspace === undefined || resolve(entry.workspace) === options.workspace),
  )
}

function wrap(text: string, width = 80): string {
  const lines: string[] = []
  let line = ""
  for (const word of text.trim().split(/\s+/)) {
    if (line && line.length + word.length + 1 > width) { lines.push(line); line = word }
    else line += `${line ? " " : ""}${word}`
  }
  if (line) lines.push(line)
  return lines.join("\n")
}

export function formatPapercuts(entries: ParsedPapercut[], json = false): string {
  if (entries.length === 0) return "No papercuts. Nice."
  if (json) return entries.map(({ raw }) => raw).join("\n")
  return entries.map(({ entry }) => `\n${entry.timestamp} — ${entry.model} — ${basename(entry.workspace)}\n\n${wrap(entry.text)}`).join("\n")
}

export async function runPapercutsCli(args: string[]): Promise<string> {
  const options = parsePapercutsArgs(args)
  let contents = ""
  try { contents = await readFile(resolve(stateDir(), "papercuts.jsonl"), "utf8") }
  catch (error: any) { if (error?.code !== "ENOENT") throw error }
  return formatPapercuts(filterPapercuts(parsePapercutLines(contents), options), options.json)
}
