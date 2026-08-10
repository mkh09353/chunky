// read — return a file's RAW text with NO line-number gutter. Dropping the
// `cat -n` gutter is the single biggest per-read token win: the model reads the
// same bytes it will later paste back into an `edit`/`apply_patch` oldText, so
// there is nothing to strip. Reads default to the first 1200 lines / 40KB (head);
// offset/limit page through larger files. All paths are jailed to the run's workspace.
import { closeSync, constants, fstatSync, openSync, readFileSync, readSync, readdirSync } from "node:fs"
import { basename, dirname, relative } from "node:path"
import { tool } from "@langchain/core/tools"
import { z } from "zod"
import { workspaceFromConfig } from "../workspace.ts"
import { MAX_BYTES, MAX_LINES, resolveInWorkspace, truncateOutput } from "./fs-util.ts"

const SNIFF_BYTES = 4_096

function startsWith(bytes: Buffer, magic: number[] | string): boolean {
  const prefix = typeof magic === "string" ? Buffer.from(magic) : Buffer.from(magic)
  return bytes.length >= prefix.length && bytes.subarray(0, prefix.length).equals(prefix)
}

function binaryMime(bytes: Buffer): string | undefined {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png"
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg"
  if (startsWith(bytes, "GIF87a") || startsWith(bytes, "GIF89a")) return "image/gif"
  if (startsWith(bytes, "RIFF") && bytes.subarray(8, 12).toString() === "WEBP") return "image/webp"
  if (startsWith(bytes, "%PDF-")) return "application/pdf"
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) || startsWith(bytes, [0x50, 0x4b, 0x05, 0x06]) || startsWith(bytes, [0x50, 0x4b, 0x07, 0x08])) return "application/zip"
  if (startsWith(bytes, [0x1f, 0x8b])) return "application/gzip"
  if (startsWith(bytes, [0x7f, 0x45, 0x4c, 0x46])) return "application/x-elf"
  if ([[0xfe, 0xed, 0xfa, 0xce], [0xce, 0xfa, 0xed, 0xfe], [0xfe, 0xed, 0xfa, 0xcf], [0xcf, 0xfa, 0xed, 0xfe], [0xca, 0xfe, 0xba, 0xbe]].some((magic) => startsWith(bytes, magic))) return "application/x-mach-binary"
  if (startsWith(bytes, "SQLite format 3\0")) return "application/vnd.sqlite3"
  if (startsWith(bytes, [0x00, 0x61, 0x73, 0x6d])) return "application/wasm"
  if (startsWith(bytes, [0x00, 0x00, 0x01, 0x00])) return "image/x-icon"
  if (startsWith(bytes, "ID3") || (bytes[0] === 0xff && (bytes[1] & 0xe6) === 0xe2)) return "audio/mpeg"
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString() === "ftyp") return "video/mp4"
  if (bytes.includes(0)) return "application/octet-stream"
  // Streaming decode permits only an incomplete multibyte sequence at the end
  // of the sniff window; malformed UTF-8 elsewhere still marks the file binary.
  try { new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: true }) } catch { return "application/octet-stream" }
  const controls = bytes.reduce((n, byte) => n + (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13 ? 1 : 0), 0)
  if (bytes.length > 0 && controls / bytes.length > 0.1) return "application/octet-stream"
}

function formatSize(bytes: number): string {
  if (bytes < 1_000) return `${bytes} B`
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(1)} KB`
  return `${(bytes / 1_000_000).toFixed(1)} MB`
}

function fileKind(stat: ReturnType<typeof fstatSync>): string {
  if (stat.isFIFO()) return "fifo"
  if (stat.isSocket()) return "socket"
  if (stat.isCharacterDevice()) return "character device"
  if (stat.isBlockDevice()) return "block device"
  if (stat.isDirectory()) return "directory"
  return "special file"
}

function inspectFile(path: string): { binary?: { mime: string; size: number }; refusal?: string } {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile()) return { refusal: `[Not a regular file (${fileKind(stat)}) — refused]` }
    const size = stat.size
    const prefix = Buffer.alloc(Math.min(size, SNIFF_BYTES))
    readSync(fd, prefix, 0, prefix.length, 0)
    const mime = binaryMime(prefix)
    return mime ? { binary: { mime, size } } : {}
  } finally { closeSync(fd) }
}

function repairCandidates(path: string): string[] {
  const seen = new Set([path])
  const pending = [path]
  while (pending.length) {
    const value = pending.pop()!
    const variants = [
      value.normalize("NFC"), value.normalize("NFD"),
      value.replaceAll("\u202f", " "), value.replaceAll(" ", "\u202f"),
      value.replaceAll("'", "’"), value.replaceAll("’", "'"),
    ]
    for (const candidate of variants) if (!seen.has(candidate)) {
      seen.add(candidate)
      pending.push(candidate)
    }
  }
  seen.delete(path)
  return [...seen]
}

function levenshtein(a: string, b: string, cap = 2): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const next = [i]
    let rowMin = i
    for (let j = 1; j <= b.length; j++) {
      next[j] = Math.min(next[j - 1] + 1, prev[j] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
      rowMin = Math.min(rowMin, next[j])
    }
    if (rowMin > cap) return cap + 1
    prev = next
  }
  return prev[b.length]
}

function notFound(path: string, workspace: string): Error {
  const parent = dirname(path)
  let entries: string[]
  try { entries = readdirSync(parent) } catch { return new Error(`file not found: ${basename(path)}`) }
  if (entries.length > 2_000) return new Error(`file not found: ${basename(path)}`)
  const wanted = basename(path).toLocaleLowerCase()
  const suggestions = entries
    .map((name) => ({ name, lower: name.toLocaleLowerCase() }))
    .filter(({ name, lower }) => {
      try { resolveInWorkspace(`${parent}/${name}`, workspace) } catch { return false }
      return lower.includes(wanted) || wanted.includes(lower) || levenshtein(wanted, lower) <= 2
    })
    .sort((a, b) => levenshtein(wanted, a.lower) - levenshtein(wanted, b.lower) || a.name.localeCompare(b.name))
    .slice(0, 3)
    .map(({ name }) => name)
  const hint = suggestions.length ? `. Did you mean ${suggestions.join(", ")}?` : ""
  return new Error(`file not found: ${basename(path)}${hint}`)
}

function findFile(path: string, workspace: string): { path: string; inspected: ReturnType<typeof inspectFile> } {
  const candidates = [path, ...repairCandidates(relative(workspace, path))]
  for (const candidate of candidates) {
    let full: string
    try { full = resolveInWorkspace(candidate, workspace) } catch { continue }
    try { return { path: full, inspected: inspectFile(full) } } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error
    }
  }
  throw notFound(path, workspace)
}

export const readInputShape = {
  path: z.string().describe("File path (relative or absolute)."),
  offset: z.number().optional().describe("1-indexed start line."),
  limit: z.number().optional().describe("Max lines to read."),
}

export const read = tool(
  async ({ path, offset, limit }: { path: string; offset?: number; limit?: number }, config?: unknown) => {
    const workspace = workspaceFromConfig(config)
    const requested = resolveInWorkspace(path, workspace)
    const { path: full, inspected } = findFile(requested, workspace)
    if (inspected.refusal) return inspected.refusal
    const binary = inspected.binary
    if (binary) {
      const hint = binary.mime === "application/pdf" ? "; use pdftotext to extract text" : ""
      return `[Binary file (${binary.mime}, ${formatSize(binary.size)}) — not shown${hint}]`
    }
    const text = readFileSync(full, "utf-8")
    if (text.length === 0) return "[File is empty]"

    const allLines = text.split("\n")
    const totalLines = allLines.length
    const startLine = offset && offset > 0 ? offset - 1 : 0
    const startDisplay = startLine + 1
    if (startLine >= allLines.length) {
      return `[offset ${offset} is past end of file — file has ${totalLines} lines]`
    }

    const endLine = limit !== undefined ? Math.min(startLine + limit, allLines.length) : allLines.length
    const selected = allLines.slice(startLine, endLine).join("\n")

    const { content } = truncateOutput(selected, { keep: "head" })
    const outputLines = content === "" ? 0 : content.split("\n").length
    const endDisplay = startDisplay + outputLines - 1
    const showedThrough = startLine + outputLines // 0-indexed exclusive end shown

    // Footer only when there is more to read: either the 1200/40KB cap fired, or a
    // user-supplied limit stopped before EOF.
    // `truncated` alone isn't enough anymore: a per-line clamp sets it even when
    // every line was shown, and a "continue" hint at EOF would point past the end.
    if (showedThrough < allLines.length) {
      return `${content}\n\n[Showing lines ${startDisplay}-${endDisplay} of ${totalLines}. Use offset=${endDisplay + 1} to continue.]`
    }
    return content
  },
  {
    name: "read",
    description: `Read a file's raw text (no line-number gutter). Capped at the first ${MAX_LINES} lines / ${MAX_BYTES / 1000}KB; use offset/limit to page through larger files.`,
    schema: z.object(readInputShape),
  },
)
