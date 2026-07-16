import { formatAnchor, parseAnchor, recoverSuffix, shifted, splitLines, validate } from "./scheme.ts"
import type { HashError, HashOp } from "./types.ts"

const ANCHOR_PREFIX = /^\s*\d+:[a-z]{1,4}(?::[a-z]{1,4})?(?:→|->)/
const CONTEXT = 3

function rejectAnchors(content: string): void {
  if (content.split("\n").some((line) => ANCHOR_PREFIX.test(line))) {
    throw new Error("Content contains hashline anchors; strip the anchor prefixes and arrow before editing.")
  }
}

function error(kind: HashError["kind"], message: string, requestedAnchor?: string, lines?: string[], line?: number): HashError {
  const current = lines && line && line >= 1 && line <= lines.length ? `${formatAnchor(line, lines)}→${lines[line - 1]}` : undefined
  const from = Math.max(1, (line ?? 1) - 5)
  const to = Math.min(lines?.length ?? 0, (line ?? 1) + 5)
  const context = lines && to >= from ? lines.slice(from - 1, to).map((text, i) => `${formatAnchor(from + i, lines)}→${text}`).join("\n") : undefined
  return { kind, message, requestedAnchor, current, context, shiftedTo: undefined, shiftedAnchor: undefined, candidates: undefined }
}

function resolveAnchor(raw: string, lines: string[]): { line: number; requested: string } | HashError {
  const requested = raw
  let anchor
  try { anchor = parseAnchor(raw) } catch {
    anchor = recoverSuffix(raw, lines)
    if (!anchor) return error("invalid_input", "Malformed anchor. Use LINE:LOCAL:CHUNK.", requested, lines)
  }
  if (validate(anchor, lines) === "valid") return { line: anchor.line, requested }
  const candidates = shifted(anchor, lines)
  if (candidates.length === 1) {
    const result = error(
      "anchor_stale",
      "Anchor moved; retry with the shifted anchor.",
      requested,
      lines,
      candidates[0],
    )
    result.shiftedTo = candidates[0]
    result.shiftedAnchor = formatAnchor(candidates[0], lines)
    return result
  }
  if (anchor.line < 1 || anchor.line > lines.length) return error("anchor_not_found", "Anchor line is outside the file; use a fresh anchor from the context.", requested, lines, anchor.line)
  const result = error(candidates.length > 1 ? "ambiguous_anchor" : "anchor_stale", "Anchor is stale; use fresh anchors from the context and retry.", requested, lines, anchor.line)
  if (candidates.length > 1) {
    result.candidates = candidates
    result.candidateAnchors = candidates.map((line) => formatAnchor(line, lines))
  }
  return result
}

function linesFor(value: string): string[] { return value === "" ? [] : value.replace(/\r\n?/g, "\n").split("\n") }

function snippet(content: string, regions: Array<[number, number]>): { text: string; start: number; ranges: Array<[number, number]> } {
  const lines = splitLines(content)
  const merged: Array<[number, number]> = []
  for (const [start, end] of regions.sort((a, b) => a[0] - b[0])) {
    const range: [number, number] = [Math.max(1, start - CONTEXT), Math.min(lines.length, end + CONTEXT)]
    const last = merged.at(-1)
    if (last && range[0] <= last[1] + 1) last[1] = Math.max(last[1], range[1])
    else merged.push(range)
  }
  const parts: string[] = []
  for (let i = 0; i < merged.length; i++) {
    if (i && merged[i][0] > merged[i - 1][1] + 1) parts.push(`... ${merged[i][0] - merged[i - 1][1] - 1} lines not shown ...`)
    const [start, end] = merged[i]
    const indexes = end - start > 7 ? [...Array.from({ length: 3 }, (_, j) => start + j), ...Array.from({ length: 3 }, (_, j) => end - 2 + j)] : Array.from({ length: end - start + 1 }, (_, j) => start + j)
    const shown = indexes.map((line, j) => `${formatAnchor(line, lines)}→${lines[line - 1]}`).join("\n")
    parts.push(end - start > 7 ? `${shown.split("\n").slice(0, 3).join("\n")}\n... ${end - start - 6} lines not shown ...\n${shown.split("\n").slice(3).join("\n")}` : shown)
  }
  return { text: parts.join("\n"), start: merged[0]?.[0] ?? 1, ranges: merged }
}

export function applyHashline(content: string, ops: HashOp[]) {
  const original = splitLines(content)
  if (ops.length === 1 && ops[0].op === "write") {
    try { rejectAnchors(ops[0].content) } catch (caught) { return { error: error("invalid_input", (caught as Error).message) } }
    const written = splitLines(ops[0].content)
    const fresh = snippet(ops[0].content, [[1, written.length]])
    return {
      text: ops[0].content,
      applied: 1,
      snippet: fresh.text,
      snippetStartLine: fresh.start,
      snippetRanges: fresh.ranges,
      warnings: [],
      details: [{ op: "write" as const, start: 1, end: written.length }],
    }
  }
  if (ops.some((op) => op.op === "write")) return { error: error("invalid_input", "write must be the only operation; no edits were applied. Retry the entire batch with fresh anchors.") }
  type Resolved = { index: number; start: number; end: number; content: string; insert: boolean }
  const resolved: Resolved[] = []
  for (const [index, op] of ops.entries()) {
    try {
      rejectAnchors(op.content)
      if (op.op === "insert_after" && op.anchor === "0:") { resolved.push({ index, start: 0, end: 0, content: op.content, insert: true }); continue }
      if (op.op === "insert_after" && op.anchor === "EOF") { resolved.push({ index, start: original.length, end: original.length, content: op.content, insert: true }); continue }
      if (op.op === "write") throw error("invalid_input", "write must be the only operation.")
      const start = resolveAnchor(op.anchor, original)
      if ("kind" in start) throw start
      if (op.op === "insert_after") resolved.push({ index, start: start.line, end: start.line, content: op.content, insert: true })
      else if (op.op === "replace") {
        let end = start.line
        if (op.end_anchor) { const resolvedEnd = resolveAnchor(op.end_anchor, original); if ("kind" in resolvedEnd) throw resolvedEnd; end = resolvedEnd.line }
        if (end < start.line) throw error("invalid_input", "end_anchor precedes anchor.", op.end_anchor, original, end)
        resolved.push({ index, start: start.line - 1, end, content: op.content, insert: false })
      }
    } catch (caught) {
      const e = (caught && typeof caught === "object" && "kind" in caught) ? caught as HashError : error("invalid_input", (caught as Error).message)
      e.message = `${e.message} No edits were applied; retry the entire batch with fresh anchors.`
      return { error: e }
    }
  }
  for (let i = 0; i < resolved.length; i++) for (let j = i + 1; j < resolved.length; j++) {
    const a = resolved[i], b = resolved[j]
    if ((!a.insert && !b.insert && a.start < b.end && b.start < a.end) || (a.insert && !b.insert && a.start >= b.start && a.start < b.end) || (b.insert && !a.insert && b.start >= a.start && b.start < a.end)) return { error: error("overlapping_edits", "Edits overlap; no edits were applied. Retry the entire batch with fresh anchors.") }
  }
  resolved.sort((a, b) => b.start - a.start || b.index - a.index)
  const output = [...original]
  const regions: Array<[number, number]> = []
  const details: Array<{ op: HashOp["op"]; start: number; end: number }> = []
  const warnings: string[] = []
  for (const op of resolved) {
    const replacement = linesFor(op.content)
    output.splice(op.start, op.end - op.start, ...replacement)
    regions.push([op.start + 1, op.start + Math.max(1, replacement.length)])
    const span = op.end - op.start
    details.push({ op: ops[op.index].op, start: op.start + 1, end: op.start + Math.max(1, span) })
    if (ops[op.index].op === "replace" && span >= 6) warnings.push(span > 20 ? `Large replacement range: ${span} lines.` : `Medium replacement range: ${span} lines.`)
  }
  const text = output.join("\n")
  const fresh = snippet(text, regions)
  return { text, applied: ops.length, snippet: fresh.text, snippetStartLine: fresh.start, snippetRanges: fresh.ranges, warnings, details }
}
