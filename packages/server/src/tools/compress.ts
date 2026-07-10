// Deterministic shell-output compression for the bash tool.
//
// Pipeline (always local, never LLM):
//   raw stdout+stderr
//     → light cleanup (ANSI / CR progress / blank collapse)
//     → optional command-aware reducer (git / gh / pm / tsc) when classification is safe
//     → signal-preserving truncate (head + important middle + tail) if still oversized
//
// Compound/piped/redirected commands skip reducers and only get the generic path.
// Full original output is always available to the caller for spill-to-temp.

import { MAX_BYTES, MAX_LINES } from "./fs-util.ts"
import { tryReduce } from "./compress-reducers.ts"

/** Below this size (after cleanup), skip reducers and truncation entirely. */
export const SMALL_OUTPUT_BYTES = 2_048

/** Head/tail kept by the signal-preserving truncator when the body is large. */
export const SIGNAL_HEAD_LINES = 40
export const SIGNAL_TAIL_LINES = 80
/** Cap on "important" middle lines (errors/warnings/diagnostics) pulled into the keep set. */
export const SIGNAL_IMPORTANT_CAP = 200

export interface CompressResult {
  /** Text returned to the model (without exit-code footer). */
  content: string
  /** True when content is shorter than the cleaned full output (reducer and/or truncate). */
  truncated: boolean
  /** Line count of the cleaned full output before size caps. */
  originalLines: number
  /** Reducer id if a command-aware reducer rewrote the body. */
  reducer: string | null
}

export interface ClassifiedCommand {
  /** First executable token (basename), e.g. "git", "gh", "bun". */
  executable: string
  /** Remaining argv tokens (unquoted-split, best-effort). */
  args: string[]
  /** args[0] when present — the subcommand for tools like git/gh. */
  subcommand: string | null
}

/**
 * Classify a shell command for reducer routing. Returns null when the command
 * is compound/piped/redirected/interactive-looking — those only get generic
 * compression so we never mis-shape mixed output.
 */
export function classifyCommand(command: string): ClassifiedCommand | null {
  const trimmed = command.trim()
  if (!trimmed) return null

  // Refuse anything that is clearly not a single simple invocation.
  // (We still compress the output generically — just no reducer.)
  if (/[|;&<>`]|\$\(|\n/.test(trimmed)) return null
  // Heredoc / multi-line already caught by \n; also skip quoted multiline-ish.
  if (/\b(vim|nvim|less|more|top|htop|ssh|tmux|screen)\b/.test(trimmed)) return null

  const tokens = tokenize(trimmed)
  if (tokens.length === 0) return null

  // Skip env assignments: FOO=bar git status
  let i = 0
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!)) i++
  if (i >= tokens.length) return null

  // Optional `command` / `env` / `nice` / `nohup` prefix
  while (i < tokens.length && /^(command|env|nice|nohup|sudo)$/.test(tokens[i]!)) {
    i++
    // sudo/env flags: skip -u user / -i etc. lightly
    while (i < tokens.length && tokens[i]!.startsWith("-")) i++
  }
  if (i >= tokens.length) return null

  const rawExe = tokens[i]!
  const executable = basenameExe(rawExe)
  const args = tokens.slice(i + 1)
  // Drop flag-only leading args when finding subcommand? Keep simple: first non-flag.
  let sub: string | null = null
  for (const a of args) {
    if (a.startsWith("-")) continue
    sub = a
    break
  }
  return { executable, args, subcommand: sub }
}

function basenameExe(exe: string): string {
  const cleaned = exe.replace(/^\\/, "") // rare Windows-ish
  const parts = cleaned.split(/[/\\]/)
  return parts[parts.length - 1] || cleaned
}

/** Minimal shell-ish tokenizer: whitespace split, respects single/double quotes. */
export function tokenize(input: string): string[] {
  const out: string[] = []
  let cur = ""
  let quote: "'" | '"' | null = null
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!
    if (quote) {
      if (ch === quote) {
        quote = null
      } else if (ch === "\\" && quote === '"' && i + 1 < input.length) {
        cur += input[++i]
      } else {
        cur += ch
      }
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      continue
    }
    if (/\s/.test(ch)) {
      if (cur) {
        out.push(cur)
        cur = ""
      }
      continue
    }
    if (ch === "\\" && i + 1 < input.length) {
      cur += input[++i]
      continue
    }
    cur += ch
  }
  if (cur) out.push(cur)
  return out
}

// ---------------------------------------------------------------------------
// Generic cleanup stages
// ---------------------------------------------------------------------------

const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)|\u001b[()][0-9A-Za-z]|\u001b[=>NO]/g

/** Strip CSI/OSC ANSI sequences so color codes don't burn tokens. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "")
}

/**
 * Normalize carriage-return progress spam: for each line, keep only the
 * segment after the last `\r` (what a terminal would finally show).
 */
export function stripProgress(text: string): string {
  if (!text.includes("\r")) return text
  return text
    .split("\n")
    .map((line) => {
      if (!line.includes("\r")) return line
      const parts = line.split("\r")
      // Prefer the last non-empty fragment (final progress frame).
      for (let i = parts.length - 1; i >= 0; i--) {
        if (parts[i]!.trim().length > 0) return parts[i]!
      }
      return parts[parts.length - 1] ?? ""
    })
    .join("\n")
}

/** Collapse runs of blank lines to a single blank line; trim trailing whitespace per line. */
export function collapseBlankLines(text: string): string {
  const lines = text.split("\n").map((l) => l.replace(/[ \t]+$/g, ""))
  const out: string[] = []
  let blank = false
  for (const line of lines) {
    if (line.trim() === "") {
      if (!blank) out.push("")
      blank = true
    } else {
      out.push(line)
      blank = false
    }
  }
  // Drop leading/trailing pure blank lines
  while (out.length && out[0] === "") out.shift()
  while (out.length && out[out.length - 1] === "") out.pop()
  return out.join("\n")
}

export function lightCleanup(text: string): string {
  return collapseBlankLines(stripProgress(stripAnsi(text)))
}

// ---------------------------------------------------------------------------
// Signal-preserving truncate
// ---------------------------------------------------------------------------

/** Lines that almost always matter more than surrounding noise. */
export const IMPORTANT_LINE_RE =
  /\b(error|err!|failed|failure|fatal|panic|exception|traceback|warning|warn\b|✖|×|✗|ERROR|FAIL(?:ED|URE)?|TS\d{3,5}|error TS)\b|:\d+:\d+|\b(?:ENOENT|EACCES|EPERM|ECONNREFUSED|ELIFECYCLE)\b/i

export function isImportantLine(line: string): boolean {
  return IMPORTANT_LINE_RE.test(line)
}

function splitLines(text: string): string[] {
  if (text.length === 0) return []
  const lines = text.split("\n")
  if (text.endsWith("\n")) lines.pop()
  return lines
}

function byteLen(s: string): number {
  return Buffer.byteLength(s, "utf-8")
}

/**
 * Keep head + important middle + tail within maxLines/maxBytes.
 * Preserves relative order. Never returns a partial line.
 */
export function signalTruncate(
  text: string,
  opts?: { maxLines?: number; maxBytes?: number; head?: number; tail?: number; importantCap?: number },
): { content: string; truncated: boolean } {
  const maxLines = opts?.maxLines ?? MAX_LINES
  const maxBytes = opts?.maxBytes ?? MAX_BYTES
  const headN = opts?.head ?? SIGNAL_HEAD_LINES
  const tailN = opts?.tail ?? SIGNAL_TAIL_LINES
  const importantCap = opts?.importantCap ?? SIGNAL_IMPORTANT_CAP

  const lines = splitLines(text)
  if (lines.length <= maxLines && byteLen(text) <= maxBytes) {
    return { content: text, truncated: false }
  }

  const n = lines.length
  const keep = new Set<number>()

  for (let i = 0; i < Math.min(headN, n); i++) keep.add(i)
  for (let i = Math.max(0, n - tailN); i < n; i++) keep.add(i)

  let importantKept = 0
  for (let i = 0; i < n && importantKept < importantCap; i++) {
    if (keep.has(i)) continue
    if (isImportantLine(lines[i]!)) {
      keep.add(i)
      importantKept++
    }
  }

  // If still over budget, drop non-important middle first (already only head/important/tail).
  // Then drop important from the middle outward, then shrink head/tail.
  let ordered = [...keep].sort((a, b) => a - b)

  const fits = (idxs: number[]): boolean => {
    if (idxs.length > maxLines) return false
    let bytes = 0
    for (let i = 0; i < idxs.length; i++) {
      bytes += byteLen(lines[idxs[i]!]!) + (i > 0 ? 1 : 0)
      if (bytes > maxBytes) return false
    }
    return true
  }

  if (!fits(ordered)) {
    // Drop important lines from the center until we fit or only head+tail remain.
    const headSet = new Set<number>()
    for (let i = 0; i < Math.min(headN, n); i++) headSet.add(i)
    const tailSet = new Set<number>()
    for (let i = Math.max(0, n - tailN); i < n; i++) tailSet.add(i)

    const middle = ordered.filter((i) => !headSet.has(i) && !tailSet.has(i))
    // drop from middle end first (later important less critical than earlier errors often)
    while (middle.length && !fits([...headSet, ...middle, ...tailSet].sort((a, b) => a - b))) {
      middle.pop()
    }
    ordered = [...headSet, ...middle, ...tailSet].sort((a, b) => a - b)

    // Still over? shrink tail then head.
    while (ordered.length > 0 && !fits(ordered)) {
      const last = ordered[ordered.length - 1]!
      const first = ordered[0]!
      // prefer dropping from the larger of head/tail regions
      if (tailSet.has(last) && ordered.length > 1) {
        ordered.pop()
      } else if (headSet.has(first)) {
        ordered.shift()
      } else {
        ordered.pop()
      }
    }
  }

  // Rebuild with omission markers where gaps appear.
  const parts: string[] = []
  let prev = -1
  let bytes = 0
  for (const idx of ordered) {
    if (prev >= 0 && idx > prev + 1) {
      const skipped = idx - prev - 1
      const marker = `… (${skipped} lines omitted) …`
      if (parts.length + 1 > maxLines) break
      if (bytes + byteLen(marker) + 1 > maxBytes) break
      parts.push(marker)
      bytes += byteLen(marker) + 1
    }
    const line = lines[idx]!
    const add = byteLen(line) + (parts.length > 0 ? 1 : 0)
    if (parts.length + 1 > maxLines) break
    if (bytes + add > maxBytes) break
    parts.push(line)
    bytes += add
    prev = idx
  }

  return { content: parts.join("\n"), truncated: true }
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

/**
 * Compress shell output for the model. `command` is the original bash string
 * (for classification). `text` is combined stdout+stderr. Exit code is not
 * embedded here — the bash tool appends it after compression.
 */
export function compressBashOutput(command: string, text: string): CompressResult {
  const cleaned = lightCleanup(text)
  const originalLines = cleaned.length === 0 ? 0 : splitLines(cleaned).length

  if (cleaned.length === 0) {
    return { content: "", truncated: false, originalLines: 0, reducer: null }
  }

  // Tiny outputs: cleanup only.
  if (byteLen(cleaned) <= SMALL_OUTPUT_BYTES && originalLines <= MAX_LINES) {
    const changed = cleaned !== text
    return {
      content: cleaned,
      truncated: changed && cleaned.length < text.length,
      originalLines,
      reducer: null,
    }
  }

  let body = cleaned
  let reducer: string | null = null
  let reduced = false

  const classified = classifyCommand(command)
  if (classified) {
    const hit = tryReduce(classified, cleaned)
    if (hit && hit.text.length > 0 && hit.text.length < cleaned.length) {
      body = hit.text
      reducer = hit.id
      reduced = true
    }
  }

  // Always run light cleanup again in case reducer introduced blanks (cheap).
  body = lightCleanup(body)

  const { content, truncated: sizeTruncated } = signalTruncate(body)
  const truncated = reduced || sizeTruncated || content.length < text.length

  return {
    content,
    truncated,
    originalLines,
    reducer,
  }
}
