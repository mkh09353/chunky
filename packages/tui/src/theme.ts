// Claude-Code-look palette + glyphs, lifted from kimi's design-system.
// Terminals inherit the user's font — we only ever set ANSI color + box-drawing.

/** Lavender brand accent (prompt marker, spinner, sparkle, ⏺ dots). Lightened
 *  two steps from Purple 600 so it holds ~9:1 contrast on dark terminals
 *  instead of ~3:1 — same family, no more squinting. */
export const ACCENT = "#c4b1f9"
/** One step deeper lavender (violet-400) — secondary rail / highlights. */
export const ACCENT_DEEP = "#a78bfa"
/** Markdown headings. Kept on the accent hue; a separate token so headings
 *  and glyph accents can diverge without touching the renderer again. */
export const HEADING = "#c4b1f9"
/** Numbered-list markers (1.) — quiet gray so list structure reads without
 *  shouting; the accent is reserved for prompt/dots/headings. */
export const MARKER = "#6b7280"
/** Bullet circles (•) — the marker gray nudged a step toward the lavender
 *  accent: still quiet, but visibly kin to the brand hue. */
export const MARKER_BULLET = "#766e91"
/** Dim gray for the input border, meta text, and tool result summaries. */
export const BORDER = "#767e89"
export const SUCCESS = "green"
export const ERROR = "red"
/** Amber for advisory notices like a cold prompt-cache warning. */
export const WARNING = "yellow"
/** Inline `code` and fenced code body — soft teal, cool counterpart to the
 *  lavender accent so code and chrome separate at a glance. */
export const CODE = "#7fd0ca"
/** Fenced-code rail / language tag — quieter than CODE. */
export const CODE_MUTED = "gray"

/** The teardrop-asterisk sparkle Claude Code shows in its welcome banner. */
export const SPARKLE = "✻"
/** The rounded ⏺ marker Claude Code uses for assistant lines and tool calls. */
export const DOT = "⏺"

/**
 * Spinner frames, adapted from kimi's getDefaultCharacters() on darwin.
 * Claude Code animates through these to make its "breathing" sparkle.
 *
 * Every frame must be a plain text glyph WITHOUT the Unicode Emoji property:
 * Terminal.app (and others) draw emoji-property glyphs with the color-emoji
 * font at two cells wide while Ink budgets one, so the text after the spinner
 * jitters sideways on those frames. That's why U+2733 ✳ (kimi's original
 * third frame, the only emoji in the set) is replaced with U+2731 ✱.
 */
const BASE_FRAMES = ["·", "✢", "✱", "✶", "✻", "✽"]
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
