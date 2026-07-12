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

/**
 * Chunky's mascot rendered as truecolor half-block art. Each entry of
 * CHUNKY_LOGO is one terminal row (`▀`/`▄` cells with 24-bit colors).
 * `wrapMode="none"` clips rather than wrapping if the terminal is narrower
 * than the art, so the rows never break mid-image. Needs a truecolor
 * terminal; older terminals show approximate/!mono colors.
 */
export function ChunkyLogo() {
  return (
    <box flexDirection="column" alignItems="flex-start">
      {LOGO_ROWS.map((row, i) => (
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
