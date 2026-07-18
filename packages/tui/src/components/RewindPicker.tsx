import { useState } from "react"
import { TextAttributes } from "@opentui/core"
import type { RewindPoint } from "@chunky/protocol"
import { ACCENT, BORDER, WARNING } from "../theme.js"
import { rawModeSupported, useInput } from "../useInput.js"
import { ago, windowStart } from "./ResumePicker.js"

/** Rows visible at once; longer lists scroll this window around the selection. */
export const REWIND_WINDOW = 10

/** Max width of the echoed user text on a rewind row before it's ellipsized. */
export const REWIND_TEXT_WIDTH = 60

/** One-line summary of a user turn: collapsed whitespace, ellipsized. */
export function truncateText(text: string, width = REWIND_TEXT_WIDTH): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > width ? flat.slice(0, width - 1) + "…" : flat
}

/**
 * The row label for a rewind point: `#<turn>  <relative time>  <user text>`.
 * Pure so the formatting is unit-testable without a terminal.
 */
export function rewindRowLabel(point: RewindPoint, now?: number): string {
  return `#${point.turn}  ${ago(point.createdAt, now)}  ${truncateText(point.userText)}`
}

/**
 * Indexes the arrow keys may land on: incomplete points (a turn that never
 * finished) have no clean state to restore, so they render dimmed and are
 * skipped entirely by navigation.
 */
export function selectableIndexes(points: RewindPoint[]): number[] {
  return points.flatMap((p, i) => (p.complete ? [i] : []))
}

/**
 * Moves the selection to the next/previous SELECTABLE row, wrapping at both
 * ends. Returns the current index unchanged when nothing is selectable.
 */
export function moveSelection(points: RewindPoint[], selected: number, delta: 1 | -1): number {
  const usable = selectableIndexes(points)
  if (usable.length === 0) return selected
  const at = usable.indexOf(selected)
  if (at < 0) return usable[0]!
  return usable[(at + delta + usable.length) % usable.length]!
}

/**
 * Arrow-navigable picker shown by /rewind: restore files AND conversation to an
 * earlier turn. Points arrive newest-first. Enter on a row does NOT rewind — it
 * opens an explicit confirmation step inside this picker, so the destructive
 * action always costs a second, deliberate Enter.
 */
export function RewindPicker({
  points,
  onConfirm,
  onCancel,
  error,
  busy,
}: {
  points: RewindPoint[]
  onConfirm: (point: RewindPoint) => void
  onCancel: () => void
  error?: string | null
  busy?: boolean
}) {
  const [selected, setSelected] = useState(() => selectableIndexes(points)[0] ?? 0)
  // The turn awaiting a second Enter. null = still browsing the list.
  const [confirming, setConfirming] = useState<RewindPoint | null>(null)

  useInput(
    (_input, key) => {
      if (busy) return
      if (confirming) {
        // Confirmation step: Enter commits, Esc drops back to the list.
        if (key.return) onConfirm(confirming)
        else if (key.escape) setConfirming(null)
        return
      }
      if (key.upArrow) return setSelected((n) => moveSelection(points, n, -1))
      if (key.downArrow) return setSelected((n) => moveSelection(points, n, 1))
      if (key.return) {
        const row = points[selected]
        if (row?.complete) setConfirming(row)
        return
      }
      if (key.escape) onCancel()
    },
    { isActive: rawModeSupported },
  )

  if (confirming) {
    return (
      <box flexDirection="column" border borderStyle="rounded" borderColor={BORDER} paddingX={1} marginBottom={1}>
        <text fg={WARNING}>
          {`This will discard files + conversation after turn ${confirming.turn}.`}
        </text>
        <text attributes={TextAttributes.DIM}>{`  ${rewindRowLabel(confirming)}`}</text>
        <text attributes={TextAttributes.DIM}>
          {busy ? "  rewinding…" : "  Enter to confirm, Esc to cancel"}
        </text>
        {error && <text fg={WARNING}>{`  ${error}`}</text>}
      </box>
    )
  }

  const start = windowStart(selected, points.length, REWIND_WINDOW)
  const visible = points.slice(start, start + REWIND_WINDOW)
  const older = points.length - start - visible.length
  return (
    <box flexDirection="column" border borderStyle="rounded" borderColor={BORDER} paddingX={1} marginBottom={1}>
      <text attributes={TextAttributes.DIM}>Rewind to a turn — ↑/↓ move · enter select · esc cancel</text>
      {start > 0 && <text attributes={TextAttributes.DIM}>{`  … ${start} newer`}</text>}
      {visible.map((p, i) => {
        const on = start + i === selected
        // Incomplete turns are unselectable: dim them and drop the pointer.
        if (!p.complete) {
          return (
            <text key={p.turn} attributes={TextAttributes.DIM}>
              {`  ${rewindRowLabel(p)}  (incomplete)`}
            </text>
          )
        }
        return (
          <box key={p.turn} flexDirection="row">
            <text fg={on ? ACCENT : undefined}>{on ? "❯ " : "  "}</text>
            <text fg={on ? ACCENT : undefined} attributes={on ? TextAttributes.BOLD : 0}>
              {rewindRowLabel(p)}
            </text>
          </box>
        )
      })}
      {older > 0 && <text attributes={TextAttributes.DIM}>{`  … ${older} older`}</text>}
      {error && <text fg={WARNING}>{`  ${error}`}</text>}
    </box>
  )
}
