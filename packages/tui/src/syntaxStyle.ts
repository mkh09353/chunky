import { SyntaxStyle } from "@opentui/core"
import { ACCENT_DEEP, BORDER, CODE, CODE_MUTED, HEADING, isIncognitoTheme, MARKER_BULLET, themeAppearance } from "./theme.js"

// Syntax palette for fenced code inside assistant markdown. Chunky's chrome
// palette (theme.ts) is lavender + teal on dark; a code theme needs a few more
// hues, so these extend it (kanagawa / one-dark-ish) tuned for dark terminals.
const DARK = { KEYWORD: "#c4b1f9", STRING: "#98c379", NUMBER: "#d19a66", FUNC: "#7fd0ca", TYPE: "#e5c07b", VARIABLE: "#cdd3de", OPERATOR: "#9aa0ab", BUILTIN: "#e06c75" }
const LIGHT = { KEYWORD: "#6d28d9", STRING: "#116329", NUMBER: "#953800", FUNC: "#0f766e", TYPE: "#8250df", VARIABLE: "#1f2328", OPERATOR: "#57606a", BUILTIN: "#cf222e" }

// Tree-sitter scope → style, adapted from opencode's mapping onto Chunky's
// palette. Drives BOTH markdown markup (headings/bold/links/inline code) and
// fenced-code highlighting for the parsers bundled with @opentui/core (markdown,
// typescript, javascript, zig). Other languages fall back to plain text — no
// parser is fetched from the network unless one is registered with a URL, which
// we never do.
// Built per call, not once at module load: the markdown markup rules read the
// accent tokens, and those retint when the attached session is incognito.
const rules = () => {
  const colors = themeAppearance() === "light" ? LIGHT : DARK
  const { KEYWORD, STRING, NUMBER, FUNC, TYPE, VARIABLE, OPERATOR, BUILTIN } = colors
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
    scope: ["operator", "punctuation", "punctuation.bracket", "punctuation.delimiter", "punctuation.special"],
    style: { foreground: OPERATOR },
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

// One SyntaxStyle per accent palette (lavender / incognito red). Each wraps a
// native handle, but there are only ever two and they live for the process, so
// caching them is correct and there's nothing to destroy() before exit. Created
// lazily so the first call lands after the renderer's native lib is initialized.
const cached = new Map<string, SyntaxStyle>()
export function getSyntaxStyle(): SyntaxStyle {
  const key = `${themeAppearance()}-${isIncognitoTheme() ? "incognito" : "normal"}`
  let style = cached.get(key)
  if (!style) {
    style = SyntaxStyle.fromTheme(rules())
    cached.set(key, style)
  }
  return style
}
