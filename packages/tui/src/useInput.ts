import { useKeyboard } from "@opentui/react"
import type { KeyEvent } from "@opentui/core"

/** Ink-shaped key flags, derived from OpenTUI's ParsedKey names. */
export interface InputKey {
  upArrow: boolean
  downArrow: boolean
  leftArrow: boolean
  rightArrow: boolean
  pageUp: boolean
  pageDown: boolean
  return: boolean
  escape: boolean
  tab: boolean
  backspace: boolean
  delete: boolean
  ctrl: boolean
  shift: boolean
  meta: boolean
}

/**
 * Ink-compatible `useInput(handler, {isActive})` on top of OpenTUI's
 * `useKeyboard`. Every keyboard-driven component was written against Ink's
 * `(input, key)` signature; adapting here keeps all of that logic unchanged.
 * `useKeyboard` wraps the handler in `useEffectEvent`, so the latest closure
 * always runs — no re-subscription races on re-render.
 */
export function useInput(
  handler: (input: string, key: InputKey) => void,
  options: { isActive?: boolean } = {},
): void {
  const { isActive = true } = options
  useKeyboard((ev: KeyEvent) => {
    if (!isActive) return
    if (ev.eventType === "release") return
    const name = ev.name ?? ""
    const key: InputKey = {
      upArrow: name === "up",
      downArrow: name === "down",
      leftArrow: name === "left",
      rightArrow: name === "right",
      pageUp: name === "pageup",
      pageDown: name === "pagedown",
      return: name === "return" || name === "linefeed",
      escape: name === "escape",
      tab: name === "tab",
      backspace: name === "backspace",
      delete: name === "delete",
      ctrl: Boolean(ev.ctrl),
      shift: Boolean(ev.shift),
      // Ink folds alt/option into `meta`; match that so existing checks hold.
      meta: Boolean(ev.meta || ev.option),
    }
    handler(printableInput(ev, key), key)
  })
}

/** The `input` string Ink would report: the typed character(s), or "" for
 *  named/control keys (arrows, esc, ctrl-combos carry the base letter). */
function printableInput(ev: KeyEvent, key: InputKey): string {
  const named =
    key.upArrow ||
    key.downArrow ||
    key.leftArrow ||
    key.rightArrow ||
    key.pageUp ||
    key.pageDown ||
    key.return ||
    key.escape ||
    key.tab ||
    key.backspace ||
    key.delete
  if (named) return ""
  const name = ev.name ?? ""
  if (name === "space") return " "
  // Ctrl/meta chords: the sequence is a control byte; report the base letter.
  if (ev.ctrl || ev.meta || ev.option) return name.length === 1 ? name : ""
  const seq = ev.sequence ?? ""
  if (seq && !/[\x00-\x1f\x7f]/.test(seq)) return seq
  return name.length === 1 ? name : ""
}

/** Whether stdin is a real TTY (raw keyboard input available). Replaces Ink's
 *  `useStdin().isRawModeSupported`. */
export const rawModeSupported = Boolean(process.stdin.isTTY)
