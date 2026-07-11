// Desktop notification when a turn finishes — the OSC 777 escape, straight to
// the terminal, no dependencies (ported from mitsuhiko's pi notify extension).
// Ghostty / iTerm2 / WezTerm render it as a native notification (typically only
// when the window is unfocused); unsupported terminals ignore the sequence.

/** Turns shorter than this don't notify: quick turns mean the user is right
 *  there, and history replay on reconnect processes events in milliseconds. */
export const MIN_NOTIFY_MS = 3_000

/** OSC 777 notify: ESC ] 777 ; notify ; title ; body BEL */
function osc777(title: string, body: string): void {
  process.stdout.write(`\x1b]777;notify;${title};${body}\x07`)
}

/** Notify that the agent finished and is waiting for input. Body is the start
 *  of the final assistant message, flattened to one line. */
export function notifyTurnEnd(finalText: string | null): void {
  const normalized = (finalText ?? "").replace(/\s+/g, " ").trim()
  const body = normalized.length > 200 ? normalized.slice(0, 199) + "…" : normalized
  osc777("Chunky", body || "Ready for input")
}
