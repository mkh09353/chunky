import { isIncognitoTheme } from "../theme.js"
import { CHUNKY_LOGO } from "./chunky-logo-art.js"

/** One run of same-styled cells in a logo row. */
interface ArtSpan {
  text: string
  fg?: string
  bg?: string
}

/**
 * Parse one row of the logo's raw ANSI (24-bit SGR) into styled spans. Ink
 * passed the escapes straight to the terminal; OpenTUI renders into its own
 * buffer and would print them literally, so the `38;2`/`48;2` colours are
 * lifted into span props instead. Only the codes the art generator emits are
 * handled: truecolor fg/bg and reset.
 */
function parseAnsiRow(row: string): ArtSpan[] {
  const spans: ArtSpan[] = []
  let fg: string | undefined
  let bg: string | undefined
  let i = 0
  while (i < row.length) {
    const esc = row.indexOf("\u001b[", i)
    if (esc === -1) {
      if (i < row.length) spans.push({ text: row.slice(i), fg, bg })
      break
    }
    if (esc > i) spans.push({ text: row.slice(i, esc), fg, bg })
    const end = row.indexOf("m", esc)
    if (end === -1) break // malformed tail; drop it
    const params = row.slice(esc + 2, end).split(";").map(Number)
    for (let p = 0; p < params.length; p++) {
      const code = params[p]!
      if (code === 0) {
        fg = undefined
        bg = undefined
      } else if ((code === 38 || code === 48) && params[p + 1] === 2) {
        const hex = `#${[params[p + 2]!, params[p + 3]!, params[p + 4]!]
          .map((v) => (v & 0xff).toString(16).padStart(2, "0"))
          .join("")}`
        if (code === 38) fg = hex
        else bg = hex
        p += 4
      }
    }
    i = end + 1
  }
  return spans
}

// The art never changes; parse it once at module load.
const LOGO_ROWS: ArtSpan[][] = CHUNKY_LOGO.map(parseAnsiRow)

/** Hue of the incognito accent (#ff3b30), in degrees. */
const INCOGNITO_HUE = 4

/**
 * Rotate the mascot's purple onto the incognito red, leaving everything else
 * alone. The art is a gradient of one hue plus neutral grays (the laptop, the
 * highlights), so moving only the violet band keeps every shade and shadow —
 * the gorilla goes red without turning into a flat silhouette.
 */
export function recolor(hex: string | undefined): string | undefined {
  if (!hex) return hex
  const n = Number.parseInt(hex.slice(1), 16)
  const r = ((n >> 16) & 0xff) / 255
  const g = ((n >> 8) & 0xff) / 255
  const b = (n & 0xff) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  const d = max - min
  if (d === 0) return hex // gray — nothing to rotate
  const s = d / (1 - Math.abs(2 * l - 1))
  let h: number
  if (max === r) h = 60 * (((g - b) / d) % 6)
  else if (max === g) h = 60 * ((b - r) / d + 2)
  else h = 60 * ((r - g) / d + 4)
  if (h < 0) h += 360
  if (h < 230 || h > 320) return hex // not the brand violet (laptop, screen, edges)
  return hslToHex(INCOGNITO_HUE, s, l)
}

function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x]
  return `#${[r!, g!, b!].map((v) => Math.round((v + m) * 255).toString(16).padStart(2, "0")).join("")}`
}

// Built on first incognito render, then reused — the rotation is deterministic.
let incognitoRows: ArtSpan[][] | undefined
function logoRows(): ArtSpan[][] {
  if (!isIncognitoTheme()) return LOGO_ROWS
  return (incognitoRows ??= LOGO_ROWS.map((row) => row.map((s) => ({ ...s, fg: recolor(s.fg), bg: recolor(s.bg) }))))
}

/**
 * Chunky's mascot rendered as truecolor half-block art. Each entry of
 * CHUNKY_LOGO is one terminal row (`▀`/`▄` cells with 24-bit colors).
 * `wrapMode="none"` clips rather than wrapping if the terminal is narrower
 * than the art, so the rows never break mid-image. Needs a truecolor
 * terminal; older terminals show approximate/!mono colors. In an incognito
 * session the purple is rotated onto the accent's red, like the rest of the UI.
 */
export function ChunkyLogo() {
  return (
    <box flexDirection="column" alignItems="flex-start">
      {logoRows().map((row, i) => (
        <text key={i} wrapMode="none">
          {row.map((s, j) => (
            <span key={j} fg={s.fg} bg={s.bg}>
              {s.text}
            </span>
          ))}
        </text>
      ))}
    </box>
  )
}
