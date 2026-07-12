// Central place for every CHUNKY_* environment toggle the TUI reads, so they're
// discoverable in one file instead of scattered `process.env` checks.
//
// The `truthy` helper matters: a bare `!process.env.X` treats "0" and "false" as
// ON (any non-empty string is truthy), so `CHUNKY_DISABLE_MOUSE=0` would wrongly
// disable the mouse. truthy() reads the common falsy spellings as OFF.

function truthy(v: string | undefined): boolean {
  if (!v) return false
  const s = v.trim().toLowerCase()
  return s !== "" && s !== "0" && s !== "false" && s !== "no" && s !== "off"
}

export const Flag = {
  /** Harness/server port override (else the protocol DEFAULT_PORT). */
  get port(): string | undefined {
    return process.env.CHUNKY_PORT || undefined
  },
  /** Hand mouse + selection back to the terminal (native ⌥-drag select + ⌘C)
   *  instead of OpenTUI's in-app selection/copy-on-select. */
  get disableMouse(): boolean {
    return truthy(process.env.CHUNKY_DISABLE_MOUSE)
  },
  /** Skip the mock auto-run demo turn so the input starts idle. */
  get noDemo(): boolean {
    return truthy(process.env.CHUNKY_NO_DEMO)
  },
} as const
