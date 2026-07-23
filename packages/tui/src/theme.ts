// Claude-Code-look palette + glyphs, lifted from kimi's design-system.
// Terminals inherit the user's font — we only ever set ANSI color + box-drawing.

/** The accent family, in both flavours. Structure is identical so the incognito
 *  swap is a pure hue change: a lightened headline accent (contrast on dark
 *  terminals), one deeper step for rails/links, headings on the accent hue, and
 *  a quiet gray nudged toward that hue for bullets. */
type Palette = Record<"ACCENT" | "ACCENT_DEEP" | "HEADING" | "MARKER_BULLET" | "MARKER" | "BORDER" | "SUCCESS" | "ERROR" | "WARNING" | "CODE" | "CODE_MUTED", string>
const PALETTES: Record<Appearance, Record<"normal" | "incognito", Palette>> = {
  dark: {
    normal: {
    ACCENT: "#c4b1f9",
    ACCENT_DEEP: "#a78bfa",
    HEADING: "#c4b1f9",
    MARKER_BULLET: "#766e91",
    MARKER: "#6b7280", BORDER: "#767e89", SUCCESS: "green", ERROR: "red", WARNING: "yellow",
    CODE: "#7fd0ca", CODE_MUTED: "gray",
    },
    incognito: {
    ACCENT: "#ff5f56",
    ACCENT_DEEP: "#ff3b30",
    HEADING: "#ff5f56",
    MARKER_BULLET: "#916e6e",
    MARKER: "#6b7280", BORDER: "#767e89", SUCCESS: "green", ERROR: "red", WARNING: "yellow",
    CODE: "#7fd0ca", CODE_MUTED: "gray",
    },
  },
  light: {
    normal: {
      ACCENT: "#6d28d9", ACCENT_DEEP: "#5b21b6", HEADING: "#6d28d9", MARKER_BULLET: "#4b5563",
      MARKER: "#374151", BORDER: "#4b5563", SUCCESS: "#15803d", ERROR: "#b91c1c", WARNING: "#a16207",
      CODE: "#0f766e", CODE_MUTED: "#4b5563",
    },
    incognito: {
      ACCENT: "#b91c1c", ACCENT_DEEP: "#991b1b", HEADING: "#b91c1c", MARKER_BULLET: "#7f1d1d",
      MARKER: "#374151", BORDER: "#4b5563", SUCCESS: "#15803d", ERROR: "#991b1b", WARNING: "#a16207",
      CODE: "#0f766e", CODE_MUTED: "#4b5563",
    },
  },
} as const

// The accent tokens are `let`, not `const`, so setIncognitoTheme() can retint the
// whole UI in one place: ESM exports are LIVE bindings, so every `import { ACCENT }`
// site reads the current value at render time without a single call-site change.
// Reassign them ONLY through setIncognitoTheme.

/** Brand accent (prompt marker, spinner, sparkle, ⏺ dots). Lightened two steps
 *  from Purple 600 so it holds ~9:1 contrast on dark terminals instead of ~3:1
 *  — same family, no more squinting. Bright red in an incognito session. */
type Appearance = "light" | "dark"
let appearance: Appearance = "dark"
export let ACCENT: string = PALETTES.dark.normal.ACCENT
/** One step deeper accent (violet-400) — secondary rail / highlights. */
export let ACCENT_DEEP: string = PALETTES.dark.normal.ACCENT_DEEP
/** Markdown headings. Kept on the accent hue; a separate token so headings
 *  and glyph accents can diverge without touching the renderer again. */
export let HEADING: string = PALETTES.dark.normal.HEADING
/** Numbered-list markers (1.) — quiet gray so list structure reads without
 *  shouting; the accent is reserved for prompt/dots/headings. */
export let MARKER: string = PALETTES.dark.normal.MARKER
/** Bullet circles (•) — the marker gray nudged a step toward the accent hue:
 *  still quiet, but visibly kin to the brand hue. */
export let MARKER_BULLET: string = PALETTES.dark.normal.MARKER_BULLET

let incognito = false

/** Is the attached session off the record? Drives the INCOGNITO badges. */
export function isIncognitoTheme(): boolean {
  return incognito
}

/**
 * Point the accent tokens at the incognito (red) or the default (lavender)
 * palette. Called from App when a session is created/attached — the caller then
 * re-renders, and every component picks the new colors up through the live
 * bindings. Returns true when the palette actually changed, so callers can skip
 * work (rebuilding the syntax theme, recoloring the logo) on a no-op.
 */
export function setIncognitoTheme(on: boolean): boolean {
  if (on === incognito) return false
  incognito = on
  const palette = PALETTES[appearance][on ? "incognito" : "normal"]
  ACCENT = palette.ACCENT
  ACCENT_DEEP = palette.ACCENT_DEEP
  HEADING = palette.HEADING
  MARKER = palette.MARKER
  MARKER_BULLET = palette.MARKER_BULLET
  BORDER = palette.BORDER; SUCCESS = palette.SUCCESS; ERROR = palette.ERROR; WARNING = palette.WARNING
  CODE = palette.CODE; CODE_MUTED = palette.CODE_MUTED
  return true
}

export function setThemeAppearance(next: Appearance): boolean {
  if (next === appearance) return false
  appearance = next
  const palette = PALETTES[appearance][incognito ? "incognito" : "normal"]
  ACCENT = palette.ACCENT; ACCENT_DEEP = palette.ACCENT_DEEP; HEADING = palette.HEADING
  MARKER = palette.MARKER; MARKER_BULLET = palette.MARKER_BULLET; BORDER = palette.BORDER
  SUCCESS = palette.SUCCESS; ERROR = palette.ERROR; WARNING = palette.WARNING
  CODE = palette.CODE; CODE_MUTED = palette.CODE_MUTED
  return true
}
export function themeAppearance(): Appearance { return appearance }

/** Label shown wherever the UI has to shout that this session is off the record. */
export const INCOGNITO_LABEL = "INCOGNITO"
/** The incognito red as a FIXED color, for marking OTHER sessions as off the
 *  record (the resume picker) — those rows must read red even while the attached
 *  session is a normal one and ACCENT is still lavender. */
export const INCOGNITO_ACCENT = PALETTES.dark.incognito.ACCENT
/** Dim gray for the input border, meta text, and tool result summaries. */
export let BORDER = PALETTES.dark.normal.BORDER
export let SUCCESS = PALETTES.dark.normal.SUCCESS
export let ERROR = PALETTES.dark.normal.ERROR
/** Amber for advisory notices like a cold prompt-cache warning. */
export let WARNING = PALETTES.dark.normal.WARNING
/** Inline `code` and fenced code body — soft teal, cool counterpart to the
 *  lavender accent so code and chrome separate at a glance. */
export let CODE = PALETTES.dark.normal.CODE
/** Fenced-code rail / language tag — quieter than CODE. */
export let CODE_MUTED = PALETTES.dark.normal.CODE_MUTED

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
