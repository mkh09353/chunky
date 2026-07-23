/** Best-effort terminal background detection. This runs before OpenTUI owns stdin. */
export type TerminalAppearance = "dark" | "light" | "unknown"

function colorFgbg(): TerminalAppearance {
  const raw = process.env.COLORFGBG
  if (!raw) return "unknown"
  const value = Number(raw.split(";").at(-1))
  if ([0, 1, 2, 3, 4, 5, 6, 8].includes(value)) return "dark"
  if (value === 7 || value === 15) return "light"
  return "unknown"
}

function oscAppearance(text: string): TerminalAppearance {
  const match = text.match(/\x1b\]11;rgb:([0-9a-f]{4})\/([0-9a-f]{4})\/([0-9a-f]{4})(?:\x07|\x1b\\)/i)
  if (!match) return "unknown"
  const [r, g, b] = match.slice(1, 4).map((v) => Number.parseInt(v!, 16) / 65535)
  // Relative luminance, with a deliberately generous midpoint for terminal themes.
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b
  return luminance >= 0.5 ? "light" : "dark"
}

/** Query OSC 11 when possible, falling back immediately to COLORFGBG. */
export async function detect(): Promise<TerminalAppearance> {
  const input = process.stdin
  const output = process.stdout
  if (!input.isTTY || !output.isTTY || typeof input.on !== "function") return colorFgbg()

  const raw = input.isRaw
  const query = "\x1b]11;?\x1b\\"
  return await new Promise<TerminalAppearance>((resolve) => {
    let settled = false
    let received = ""
    const finish = (appearance: TerminalAppearance) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      input.off("data", onData)
      // Put back anything that was not the terminal's OSC response. This keeps
      // a key pressed during the short query available to the renderer.
      const response = /\x1b\]11;rgb:[0-9a-f]{4}\/[0-9a-f]{4}\/[0-9a-f]{4}(?:\x07|\x1b\\)/i
      const remainder = received.replace(response, "")
      if (remainder && typeof input.unshift === "function") input.unshift(Buffer.from(remainder))
      if (typeof input.setRawMode === "function" && raw !== undefined) input.setRawMode(raw)
      input.pause()
      resolve(appearance === "unknown" ? colorFgbg() : appearance)
    }
    const onData = (chunk: Buffer | string) => {
      received += chunk.toString()
      const appearance = oscAppearance(received)
      if (appearance !== "unknown") finish(appearance)
      // A terminal response is normally a single chunk. Do not consume unrelated
      // input that happened to arrive while the query was outstanding.
      else if (received.length > 256) finish("unknown")
    }
    const timer = setTimeout(() => finish("unknown"), 150)
    input.on("data", onData)
    if (typeof input.setRawMode === "function") input.setRawMode(true)
    output.write(query)
  })
}

export default detect
