// Claude-Code-look palette + glyphs, lifted from kimi's design-system.
// Terminals inherit the user's font — we only ever set ANSI color + box-drawing.

/** Anthropic clay / terracotta accent used for the prompt marker, spinner, sparkle. */
export const ACCENT = "#d97757"
/** Slightly deeper clay, used for secondary accent highlights. */
export const ACCENT_DEEP = "#cc785c"
/** Dim gray for the input border, meta text, and tool result summaries. */
export const BORDER = "gray"
export const SUCCESS = "green"
export const ERROR = "red"
/** Inline `code` and fenced code body — readable on dark and light terminals. */
export const CODE = "cyan"
/** Fenced-code rail / language tag — quieter than CODE. */
export const CODE_MUTED = "gray"

/** The teardrop-asterisk sparkle Claude Code shows in its welcome banner. */
export const SPARKLE = "✻"
/** The rounded ⏺ marker Claude Code uses for assistant lines and tool calls. */
export const DOT = "⏺"

/**
 * Spinner frames, verbatim from kimi's getDefaultCharacters() on darwin.
 * Claude Code animates through these to make its "breathing" sparkle.
 */
const BASE_FRAMES = ["·", "✢", "✳", "✶", "✻", "✽"]
export const SPINNER_FRAMES = [...BASE_FRAMES, ...[...BASE_FRAMES].reverse()]

/** A small, on-brand slice of kimi's spinner verb list. */
export const SPINNER_VERBS = [
  "Thinking",
  "Working",
  "Cooking",
  "Brewing",
  "Crafting",
  "Composing",
  "Computing",
  "Conjuring",
  "Considering",
  "Contemplating",
  "Crunching",
  "Divining",
  "Forging",
  "Hatching",
  "Herding",
  "Noodling",
  "Percolating",
  "Pondering",
  "Puzzling",
  "Reticulating",
  "Simmering",
  "Synthesizing",
  "Whirring",
]
