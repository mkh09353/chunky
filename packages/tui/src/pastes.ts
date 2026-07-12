// Collapsing large/multi-line pastes to a placeholder chip in the prompt.
//
// Ink hands a whole paste to the input callback as one multi-character string,
// with terminal newlines encoded as CR. Left as-is, those CRs overwrite lines in
// the band (and in the echoed message), and a huge paste floods the transcript.
// So we collapse a big paste to a chip like `[Pasted text #1 +42 lines]`, keep
// the full body keyed by that chip, and splice it back in before the message is
// sent — the model always receives everything; only the on-screen copy shrinks.

// A pasted chunk with more than this many lines, or this many characters, is
// collapsed to a chip rather than inserted inline.
export const PASTE_LINE_THRESHOLD = 4
export const PASTE_CHAR_THRESHOLD = 400

/** Normalize terminal CRs to LF so a multi-line paste can't overwrite lines. */
export function normalizePaste(input: string): string {
  return input.replace(/\r\n?/g, "\n")
}

/** Whether a (normalized) pasted chunk is big enough to collapse to a chip. */
export function shouldCollapsePaste(text: string): boolean {
  return text.split("\n").length > PASTE_LINE_THRESHOLD || text.length > PASTE_CHAR_THRESHOLD
}

/** The chip shown in place of a collapsed paste, e.g. `[Pasted text #1 +42 lines]`. */
export function pasteLabel(id: number, text: string): string {
  const lines = text.split("\n").length
  const detail = lines > 1 ? `+${lines} lines` : `+${text.length} characters`
  return `[Pasted text #${id} ${detail}]`
}

/** Splice full paste bodies back in place of their chips, for sending to the model. */
export function expandPastes(display: string, pastes: Map<string, string>): string {
  let out = display
  for (const [token, full] of pastes) {
    if (out.includes(token)) out = out.split(token).join(full)
  }
  return out
}
