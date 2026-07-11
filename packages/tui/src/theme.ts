// Claude-Code-look palette + glyphs, lifted from kimi's design-system.
// Terminals inherit the user's font — we only ever set ANSI color + box-drawing.

/** Violet brand accent (prompt marker, spinner, sparkle, ⏺ dots). Bright purple that
 *  pops on dark terminals — kimi's dark-theme "bright purple" rgb(178,102,255). */
export const ACCENT = "#b266ff"
/** Deeper purple (kimi's Purple 600, rgb(147,51,234)) — secondary rail / highlights. */
export const ACCENT_DEEP = "#9333ea"
/** Dim gray for the input border, meta text, and tool result summaries. */
export const BORDER = "gray"
export const SUCCESS = "green"
export const ERROR = "red"
/** Amber for advisory notices like a cold prompt-cache warning. */
export const WARNING = "yellow"
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
