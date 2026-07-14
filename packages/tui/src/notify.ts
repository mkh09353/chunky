// Desktop notification when a turn finishes — the OSC 777 escape, straight to
// the terminal, no dependencies (ported from mitsuhiko's pi notify extension).
// Ghostty / iTerm2 / WezTerm render it as a native notification (typically only
// when the window is unfocused); unsupported terminals ignore the sequence.

/** Turns shorter than this don't notify: quick turns mean the user is right
 *  there, and history replay on reconnect processes events in milliseconds. */
export const MIN_NOTIFY_MS = 3_000

/** Strip control characters before putting user/model text in an OSC sequence. */
function sanitizeOscText(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
}

/** Set the terminal window title using OSC 0. */
export function setTerminalTitle(title: string): void {
  process.stdout.write(`\x1b]0;${sanitizeOscText(title)}\x07`)
}

/** OSC 777 notify: ESC ] 777 ; notify ; title ; body BEL */
function osc777(title: string, body: string): void {
  process.stdout.write(`\x1b]777;notify;${sanitizeOscText(title)};${sanitizeOscText(body)}\x07`)
}

/** Bundled ship's horn (we shipped something) — see scripts/make-horn.ts. */
const HORN = new URL("../assets/horn.wav", import.meta.url).pathname

/** Play the completion sound. Configurable via CHUNKY_NOTIFY_SOUND:
 *  - unset → the bundled ship's horn
 *  - a file path → played with afplay (macOS) / paplay (Linux)
 *  - "bell" → plain terminal bell
 *  - "off" → silent */
function playSound(): void {
  const pref = process.env.CHUNKY_NOTIFY_SOUND?.trim()
  if (pref === "off") return
  if (pref === "bell") {
    process.stdout.write("\x07")
    return
  }
  const player = process.platform === "darwin" ? "afplay" : "paplay"
  const file = pref || HORN
  try {
    const child = Bun.spawn([player, file], { stdout: "ignore", stderr: "ignore" })
    void child.exited.catch(() => {})
  } catch {
    process.stdout.write("\x07")
  }
}

/** Mark the terminal as busy while the agent is responding. */
export function notifyTurnStart(): void {
  setTerminalTitle("Chunky — working…")
}

/** Restore the ordinary Chunky terminal title. */
export function resetTerminalTitle(): void {
  setTerminalTitle("Chunky")
}

/** Notify that the agent finished and is waiting for input. Body is the start
 *  of the final assistant message, flattened to one line. */
export function notifyTurnEnd(finalText: string | null): void {
  const normalized = (finalText ?? "").replace(/\s+/g, " ").trim()
  const body = normalized.length > 200 ? normalized.slice(0, 199) + "…" : normalized
  setTerminalTitle("● Chunky — done")
  osc777("Chunky", body || "Ready for input")
  playSound()
}
