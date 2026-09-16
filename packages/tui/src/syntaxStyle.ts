import { SyntaxStyle, convertThemeToStyles } from "@opentui/core"
import { ACCENT_DEEP, BORDER, CODE, CODE_MUTED, HEADING, MARKER_BULLET, SYNTAX, themeRevision } from "./theme.js"

// Syntax palette for fenced code inside assistant markdown. Chunky's chrome
// palette (theme.ts) is lavender + teal on dark; a code theme needs a few more
// hues, so these extend it (kanagawa / one-dark-ish) tuned for dark terminals.

// Tree-sitter scope → style, adapted from opencode's mapping onto Chunky's
// palette. Drives BOTH markdown markup (headings/bold/links/inline code) and
// fenced-code highlighting for the parsers bundled with @opentui/core (markdown,
// typescript, javascript, zig). Other languages fall back to plain text — no
// parser is fetched from the network unless one is registered with a URL, which
// we never do.
// Rebuilt when the theme changes, including incognito accent changes.
const rules = () => {
  const { KEYWORD, STRING, NUMBER, FUNC, TYPE, VARIABLE, OPERATOR, PUNCTUATION, BUILTIN } = SYNTAX
  return [
  // ── code ──
  { scope: ["comment", "comment.documentation"], style: { foreground: CODE_MUTED, italic: true } },
  { scope: ["string", "symbol", "character", "character.special", "string.special"], style: { foreground: STRING } },
  { scope: ["string.escape", "string.regexp"], style: { foreground: KEYWORD } },
  { scope: ["number", "boolean", "constant", "constant.builtin", "float"], style: { foreground: NUMBER } },
  {
    scope: [
      "keyword",
      "keyword.return",
      "keyword.conditional",
      "keyword.repeat",
      "keyword.import",
      "keyword.modifier",
      "keyword.exception",
      "keyword.directive",
      "keyword.operator",
    ],
    style: { foreground: KEYWORD, italic: true },
  },
  { scope: ["keyword.function", "function", "function.method", "constructor"], style: { foreground: FUNC } },
  {
    scope: [
      "function.call",
      "function.method.call",
      "variable",
      "variable.parameter",
      "variable.member",
      "property",
      "parameter",
    ],
    style: { foreground: VARIABLE },
  },
  { scope: ["type", "type.builtin", "keyword.type", "module", "class"], style: { foreground: TYPE } },
  {
    scope: ["operator"],
    style: { foreground: OPERATOR },
  },
  {
    scope: ["punctuation", "punctuation.bracket", "punctuation.delimiter", "punctuation.special"],
    style: { foreground: PUNCTUATION },
  },
  {
    scope: ["variable.builtin", "function.builtin", "module.builtin", "variable.super"],
    style: { foreground: BUILTIN },
  },
  // ── markdown markup ──
  {
    scope: [
      "markup.heading",
      "markup.heading.1",
      "markup.heading.2",
      "markup.heading.3",
      "markup.heading.4",
      "markup.heading.5",
      "markup.heading.6",
    ],
    style: { foreground: HEADING, bold: true },
  },
  { scope: ["markup.bold", "markup.strong"], style: { bold: true } },
  { scope: ["markup.italic"], style: { italic: true } },
  { scope: ["markup.list"], style: { foreground: MARKER_BULLET } },
  { scope: ["markup.quote"], style: { foreground: BORDER, italic: true } },
  { scope: ["markup.raw", "markup.raw.block", "markup.raw.inline"], style: { foreground: CODE } },
  {
    scope: ["markup.link", "markup.link.label", "markup.link.url", "string.special.url"],
    style: { foreground: ACCENT_DEEP, underline: true },
  },
  { scope: ["conceal"], style: { foreground: BORDER } },
  ]
}

// Keep the same native style and replace its rules on theme changes. Existing
// markdown renderables can retain the handle without stale colors or leaks.
let cached: SyntaxStyle | undefined
let cachedRevision = -1
export function getSyntaxStyle(): SyntaxStyle {
  if (cached && cachedRevision === themeRevision()) return cached
  const next = rules()
  if (!cached) cached = SyntaxStyle.fromTheme(next)
  else {
    for (const [scope, style] of Object.entries(convertThemeToStyles(next))) cached.registerStyle(scope, style)
    cached.clearCache()
  }
  cachedRevision = themeRevision()
  return cached
}
