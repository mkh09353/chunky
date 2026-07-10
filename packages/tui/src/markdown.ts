// Lightweight markdown → structured blocks/spans for terminal rendering.
// Handles the subset coding agents actually emit: headings, lists, fenced
// code, inline code/bold/italic, horizontal rules, and blank lines.
// No dependency on a full markdown library — we need deterministic, Ink-friendly
// output and zero surprise on half-streamed text mid-turn.

export type MdSpan =
  | { kind: "text"; text: string }
  | { kind: "bold"; text: string }
  | { kind: "italic"; text: string }
  | { kind: "code"; text: string }

export type MdBlock =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "bullet"; indent: number; text: string }
  | { kind: "numbered"; indent: number; n: string; text: string }
  | { kind: "code"; lang: string; lines: string[] }
  | { kind: "hr" }
  | { kind: "blank" }

/** Split assistant markdown into renderable blocks. Tolerates unclosed fences
 *  (treats remainder as code) so streaming mid-fence still looks intentional. */
export function parseBlocks(src: string): MdBlock[] {
  // Normalize newlines; keep trailing content even without a final \n.
  const lines = src.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")
  const blocks: MdBlock[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]!

    // Fenced code: ```lang?  …  ```
    const fenceOpen = /^```([\w.+-]*)\s*$/.exec(line)
    if (fenceOpen) {
      const lang = fenceOpen[1] ?? ""
      const body: string[] = []
      i++
      while (i < lines.length && !/^```\s*$/.test(lines[i]!)) {
        body.push(lines[i]!)
        i++
      }
      // Skip closing fence if present.
      if (i < lines.length && /^```\s*$/.test(lines[i]!)) i++
      blocks.push({ kind: "code", lang, lines: body })
      continue
    }

    // Blank line → vertical rhythm.
    if (/^\s*$/.test(line)) {
      // Collapse consecutive blanks into one.
      if (blocks.length === 0 || blocks[blocks.length - 1]!.kind !== "blank") {
        blocks.push({ kind: "blank" })
      }
      i++
      continue
    }

    // Horizontal rule: --- / *** / ___ (3+), alone on the line.
    if (/^\s{0,3}([-*_])\1{2,}\s*$/.test(line)) {
      blocks.push({ kind: "hr" })
      i++
      continue
    }

    // ATX heading: # … ######
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
    if (heading) {
      blocks.push({ kind: "heading", level: heading[1]!.length, text: heading[2]! })
      i++
      continue
    }

    // Unordered list item.
    const bullet = /^(\s*)([-*+])\s+(.*)$/.exec(line)
    if (bullet) {
      blocks.push({ kind: "bullet", indent: bullet[1]!.length, text: bullet[3]! })
      i++
      continue
    }

    // Ordered list item.
    const numbered = /^(\s*)(\d+)\.\s+(.*)$/.exec(line)
    if (numbered) {
      blocks.push({
        kind: "numbered",
        indent: numbered[1]!.length,
        n: numbered[2]!,
        text: numbered[3]!,
      })
      i++
      continue
    }

    // Plain paragraph line (one source line = one block; we don't reflow).
    blocks.push({ kind: "paragraph", text: line })
    i++
  }

  // Drop leading/trailing blanks so the transcript doesn't grow extra margin
  // around every assistant bubble.
  while (blocks.length > 0 && blocks[0]!.kind === "blank") blocks.shift()
  while (blocks.length > 0 && blocks[blocks.length - 1]!.kind === "blank") blocks.pop()

  return blocks
}

/**
 * Parse inline markdown into spans. Order of precedence:
 *   1. `inline code`  (so * and ** inside code stay literal)
 *   2. **bold** / __bold__
 *   3. *italic*       (not underscore — snake_case is common in agent text)
 * Everything else is plain text. Unclosed markers are left as literal text.
 * Manual scan (no lookbehind) so streaming partial tokens stay stable.
 */
export function parseInline(text: string): MdSpan[] {
  if (!text) return [{ kind: "text", text: "" }]

  const spans: MdSpan[] = []
  let i = 0
  let plain = ""

  const flush = () => {
    if (plain) {
      spans.push({ kind: "text", text: plain })
      plain = ""
    }
  }

  while (i < text.length) {
    const ch = text[i]!

    // Inline code: `…` (no newlines).
    if (ch === "`") {
      const end = text.indexOf("`", i + 1)
      if (end !== -1 && !text.slice(i + 1, end).includes("\n")) {
        flush()
        spans.push({ kind: "code", text: text.slice(i + 1, end) })
        i = end + 1
        continue
      }
    }

    // Bold: **…** or __…__
    if ((ch === "*" && text[i + 1] === "*") || (ch === "_" && text[i + 1] === "_")) {
      const marker = text.slice(i, i + 2)
      const end = text.indexOf(marker, i + 2)
      if (end !== -1) {
        flush()
        spans.push({ kind: "bold", text: text.slice(i + 2, end) })
        i = end + 2
        continue
      }
    }

    // Italic: *…* (single asterisks only — not part of **).
    if (ch === "*" && text[i + 1] !== "*") {
      let end = i + 1
      while (end < text.length) {
        if (text[end] === "*" && text[end + 1] !== "*") break
        // Don't cross a bold opener.
        if (text[end] === "*" && text[end + 1] === "*") {
          end = -1
          break
        }
        end++
      }
      if (end > i + 1 && end < text.length && text[end] === "*") {
        flush()
        spans.push({ kind: "italic", text: text.slice(i + 1, end) })
        i = end + 1
        continue
      }
    }

    plain += ch
    i++
  }
  flush()
  return spans.length > 0 ? spans : [{ kind: "text", text }]
}
