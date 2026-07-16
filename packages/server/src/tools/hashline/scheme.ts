import { encodeHash, fnv1a32, lineHash } from "./hash.ts"

export const SEARCH_RADIUS = 15
export const CHUNK_SIZE = 8

export interface ParsedAnchor { line: number; local: string; chunk: string }
export type Validation = "valid" | "stale" | "not_found"

/** Rust-compatible logical lines: an empty file has one logical line, and a final newline adds one. */
export function splitLines(content: string): string[] {
  if (content.length === 0) return [""]
  const lines = content.replace(/\r\n?/g, "\n").split("\n")
  return lines
}

function stripAnchorContent(value: string): string {
  const unicode = value.indexOf("→")
  const ascii = value.indexOf("->")
  const at = [unicode, ascii].filter((n) => n >= 0).sort((a, b) => a - b)[0]
  return at === undefined ? value.trim() : value.slice(0, at).trim()
}

export function parseAnchor(input: string): ParsedAnchor {
  const value = stripAnchorContent(input)
  const parts = value.split(":")
  if (parts.length !== 3 || !/^\d+$/.test(parts[0]) || parts[0] === "0" ||
      !/^[a-z]{1,4}$/.test(parts[1]) || !/^[a-z]{1,4}$/.test(parts[2])) {
    throw new Error("malformed hashline anchor")
  }
  return { line: Number(parts[0]), local: parts[1], chunk: parts[2] }
}

function chunkHash(lines: string[], line: number, chunkSize = CHUNK_SIZE): number {
  const start = Math.floor((line - 1) / chunkSize) * chunkSize
  let hash = fnv1a32("chunk")
  for (let i = start; i < Math.min(start + chunkSize, lines.length); i++) {
    hash = Math.imul((hash ^ lineHash(lines[i])) >>> 0, 0x01000193) >>> 0
  }
  return hash
}

export function formatAnchor(line: number, lines: string[], hashLen = 3, chunkSize = CHUNK_SIZE): string {
  return `${line}:${encodeHash(lineHash(lines[line - 1] ?? ""), hashLen)}:${encodeHash(chunkHash(lines, line, chunkSize), hashLen)}`
}

export function validate(anchor: ParsedAnchor, lines: string[]): Validation {
  if (anchor.line < 1 || anchor.line > lines.length) return "not_found"
  return formatAnchor(anchor.line, lines) === `${anchor.line}:${anchor.local}:${anchor.chunk}` ? "valid" : "stale"
}

export function shifted(anchor: ParsedAnchor, lines: string[]): number[] {
  const exact: number[] = []
  const local: number[] = []
  const from = Math.max(1, anchor.line - SEARCH_RADIUS)
  const to = Math.min(lines.length, anchor.line + SEARCH_RADIUS)
  for (let line = from; line <= to; line++) {
    if (line === anchor.line) continue
    if (encodeHash(lineHash(lines[line - 1]), 3) !== anchor.local) continue
    local.push(line)
    const candidate = formatAnchor(line, lines).split(":")
    if (candidate[2] === anchor.chunk) exact.push(line)
  }
  // Prefer the complete anchor when chunk context survived. When insertion or
  // deletion changed the chunk, a unique local hash is still a usable recovery
  // hint; duplicates remain ambiguous and are never guessed.
  return exact.length > 0 ? exact : local
}

/** Match a malformed suffix such as `abc:def` only when it identifies one line. */
export function recoverSuffix(value: string, lines: string[]): ParsedAnchor | undefined {
  const suffix = stripAnchorContent(value)
  if (!/^[a-z]{1,4}:[a-z]{1,4}$/.test(suffix)) return undefined
  const [local, chunk] = suffix.split(":")
  const matches = lines.map((_, i) => ({ line: i + 1, local, chunk }))
    .filter((a) => validate(a, lines) === "valid")
  return matches.length === 1 ? matches[0] : undefined
}

export function anchorSuffix(anchor: ParsedAnchor): string {
  return `${anchor.local}:${anchor.chunk}`
}
