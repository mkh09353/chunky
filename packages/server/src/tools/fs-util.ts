// Shared filesystem helpers for the lean tools (read/write/edit/bash). Two jobs:
//  1. resolveInWorkspace — jail every path to the run's workspace so a tool can
//     never touch (or reveal) a file outside the project root. Unlike apply-patch's
//     variant, this one ACCEPTS absolute paths that are already inside the
//     workspace, because models routinely pass absolute paths back after a `read`.
//  2. truncateOutput — cap tool output by lines OR bytes (whichever hits first),
//     keeping either the head (file reads) or the tail (shell output). Big outputs
//     are the other half of the token bill, so every tool truncates.
import { isAbsolute, relative, resolve } from "node:path"

/** Line/byte caps shared by read (head) and bash (tail). Kept modest so a single
 *  tool result can't flood the working set and slow every later model call — the
 *  agent paginates (offset/limit) or narrows its search instead. */
export const MAX_LINES = 1200
export const MAX_BYTES = 40_000
export const MAX_LINE_CHARS = 2_000

/**
 * Resolve `p` (relative OR absolute) against `workspace` and reject any escape.
 * Relative paths resolve under the workspace; absolute paths are accepted only
 * when they already live inside it. Throws on an empty path or any escape.
 */
export function resolveInWorkspace(p: string, workspace: string): string {
  const trimmed = p.trim()
  if (!trimmed) throw new Error("empty path")
  const full = isAbsolute(trimmed) ? resolve(trimmed) : resolve(workspace, trimmed)
  const rel = relative(workspace, full)
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`path escapes the workspace: ${p}`)
  }
  return full
}

export interface TruncateOptions {
  maxLines?: number
  maxBytes?: number
  /** "head" keeps the first lines (file reads); "tail" keeps the last (shell output). */
  keep: "head" | "tail"
}

export interface TruncateResult {
  content: string
  truncated: boolean
  /** Total number of lines in the original input. */
  originalLines: number
}

/** Split into lines for counting, dropping a single trailing newline's empty line. */
function splitLines(text: string): string[] {
  if (text.length === 0) return []
  const lines = text.split("\n")
  if (text.endsWith("\n")) lines.pop()
  return lines
}

/** Bound pathological minified/generated lines without splitting a surrogate pair. */
function clampLine(line: string): string {
  if (line.length <= MAX_LINE_CHARS) return line
  let end = MAX_LINE_CHARS
  const code = line.charCodeAt(end - 1)
  if (code >= 0xd800 && code <= 0xdbff) end--
  return `${line.slice(0, end)}… [line truncated, ${line.length} chars total]`
}

/**
 * Cap `text` to at most `maxLines` complete lines AND `maxBytes` bytes — whichever
 * limit is reached first wins. `keep: "head"` returns the first fitting lines,
 * `keep: "tail"` returns the last. Never returns a partial line.
 */
export function truncateOutput(text: string, opts: TruncateOptions): TruncateResult {
  const maxLines = opts.maxLines ?? MAX_LINES
  const maxBytes = opts.maxBytes ?? MAX_BYTES
  const original = splitLines(text)
  const originalLines = original.length
  const lines = original.map(clampLine)
  const linesClamped = lines.some((line, i) => line !== original[i])
  const clampedText = lines.join("\n") + (text.endsWith("\n") ? "\n" : "")
  const totalBytes = Buffer.byteLength(clampedText, "utf-8")

  if (!linesClamped && originalLines <= maxLines && totalBytes <= maxBytes) {
    return { content: text, truncated: false, originalLines }
  }
  if (originalLines <= maxLines && totalBytes <= maxBytes) {
    return { content: clampedText, truncated: true, originalLines }
  }

  const kept: string[] = []
  let bytes = 0
  if (opts.keep === "head") {
    for (let i = 0; i < lines.length && kept.length < maxLines; i++) {
      const lineBytes = Buffer.byteLength(lines[i], "utf-8") + (kept.length > 0 ? 1 : 0)
      if (bytes + lineBytes > maxBytes) break
      kept.push(lines[i])
      bytes += lineBytes
    }
  } else {
    for (let i = lines.length - 1; i >= 0 && kept.length < maxLines; i--) {
      const lineBytes = Buffer.byteLength(lines[i], "utf-8") + (kept.length > 0 ? 1 : 0)
      if (bytes + lineBytes > maxBytes) break
      kept.unshift(lines[i])
      bytes += lineBytes
    }
  }

  return { content: kept.join("\n"), truncated: true, originalLines }
}
