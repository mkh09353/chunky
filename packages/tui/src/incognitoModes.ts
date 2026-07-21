import type { ModeInfo } from "@chunky/protocol"

/**
 * A saved mode as the server actually sends it. `/api/modes` forwards each
 * stored spec verbatim, so an incognito mode arrives carrying its provider
 * allowlist — the protocol's ModeSpec doesn't declare the field yet (the server
 * owns that type), so widen it here instead of casting at every use.
 */
export type SavedMode = ModeInfo & { incognito?: { allow?: string[] } | null }

/** Is this an INCOGNITO mode — one whose spec carries an allowlist, so applying
 *  it makes new sessions off the record? The server keys its own behaviour off
 *  exactly this field (an active mode with `incognito` marks each session it
 *  creates), so "has the field" is the whole test. */
export function isIncognitoMode(mode: SavedMode): boolean {
  return mode.incognito != null
}

/**
 * What `/incognito [name]` should do, given the saved modes.
 *
 * - `apply` — exactly one incognito mode exists (or the named one is incognito).
 * - `pick`  — several: let the user choose.
 * - `none`  — none saved: explain how to make one.
 * - `not-incognito` / `unknown` — the named argument can't be applied.
 *
 * Name matching is case-insensitive to mirror the server's `getMode`, and the
 * returned name is the CANONICAL one so the apply POST hits the stored mode.
 */
export type IncognitoCommand =
  | { kind: "apply"; name: string }
  | { kind: "pick"; modes: SavedMode[] }
  | { kind: "none" }
  | { kind: "not-incognito"; name: string }
  | { kind: "unknown"; name: string }

export function resolveIncognitoCommand(modes: SavedMode[], arg: string): IncognitoCommand {
  const wanted = arg.trim()
  if (wanted) {
    const match = modes.find((m) => m.name.toLowerCase() === wanted.toLowerCase())
    if (!match) return { kind: "unknown", name: wanted }
    return isIncognitoMode(match) ? { kind: "apply", name: match.name } : { kind: "not-incognito", name: match.name }
  }
  const incognito = modes.filter(isIncognitoMode)
  if (incognito.length === 0) return { kind: "none" }
  if (incognito.length === 1) return { kind: "apply", name: incognito[0]!.name }
  return { kind: "pick", modes: incognito }
}

// ---- copy (shared by App and the picker so both say the same thing) ----

/** Nothing to apply: say what an incognito mode IS and how to save one. */
export const NO_INCOGNITO_MODES =
  'No incognito modes saved. An incognito mode is a saved mode with a provider allowlist — add `"incognito": { "allow": ["<provider-id>"] }` to a mode in Chunky\'s settings.json, where every listed provider is a custom provider with `"scope": "incognito"` (or "both"). Then `/incognito` applies it. `/mode` lists what you have saved today.'

/** Applied. `trio` is the same `<model> (<effort>) · <provider>` tail /mode prints. */
export function incognitoAppliedLine(name: string, trio: string): string {
  return `Incognito mode "${name}" applied: ${trio} — NEW sessions start off the record (nothing written to disk, red accent). Run /clear to start one; this session stays exactly as it is.`
}

/** The named mode exists but wouldn't take you off the record. */
export function notIncognitoLine(name: string): string {
  return `Incognito: mode "${name}" isn't an incognito mode — it has no provider allowlist, so applying it wouldn't take you off the record. Run \`/incognito\` to see the ones that would, or \`/mode ${name}\` to apply it as a normal mode.`
}

/** No such mode at all. */
export function unknownModeLine(name: string): string {
  return `Incognito: no saved mode named "${name}" — \`/incognito\` lists the incognito ones, \`/mode\` lists them all.`
}
