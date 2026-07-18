import { useState } from "react"
import { TextAttributes } from "@opentui/core"
import { ACCENT, BORDER, WARNING } from "../theme.js"
import { rawModeSupported, useInput } from "../useInput.js"
import { truncateText } from "./RewindPicker.js"

/**
 * Splits `/fork` arguments into a worktree choice and the directive text.
 * `--worktree` / `--no-worktree` may appear ANYWHERE in the args and are
 * stripped from the directive; with neither flag `worktree` is undefined,
 * which is what makes the caller open the ForkPicker instead of posting.
 */
export function parseForkArgs(rest: string): { worktree?: boolean; directive?: string } {
  let worktree: boolean | undefined
  const words = rest.split(/\s+/).filter(Boolean)
  const kept: string[] = []
  for (const word of words) {
    const flag = word.toLowerCase()
    if (flag === "--worktree") worktree = true
    else if (flag === "--no-worktree") worktree = false
    else kept.push(word)
  }
  const directive = kept.join(" ").trim()
  return { ...(worktree === undefined ? {} : { worktree }), ...(directive ? { directive } : {}) }
}

export const FORK_OPTIONS: { worktree: boolean; label: string }[] = [
  { worktree: false, label: "Fork in place" },
  { worktree: true, label: "Fork into a new git worktree" },
]

/**
 * The two-option chooser `/fork` opens when neither --worktree nor
 * --no-worktree was given: fork in the current workspace, or have the server
 * cut a fresh git worktree for the child session. A directive typed with the
 * command is echoed here so it's clear what the child will start on.
 */
export function ForkPicker({
  directive,
  onSelect,
  onCancel,
  error,
  busy,
}: {
  directive?: string
  onSelect: (worktree: boolean) => void
  onCancel: () => void
  error?: string | null
  busy?: boolean
}) {
  const [selected, setSelected] = useState(0)
  useInput(
    (_input, key) => {
      if (busy) return
      if (key.upArrow) return setSelected((n) => (n - 1 + FORK_OPTIONS.length) % FORK_OPTIONS.length)
      if (key.downArrow) return setSelected((n) => (n + 1) % FORK_OPTIONS.length)
      if (key.return) return onSelect(FORK_OPTIONS[selected]!.worktree)
      if (key.escape) onCancel()
    },
    { isActive: rawModeSupported },
  )
  return (
    <box flexDirection="column" border borderStyle="rounded" borderColor={BORDER} paddingX={1} marginBottom={1}>
      <text attributes={TextAttributes.DIM}>Fork this session — ↑/↓ move · enter fork · esc cancel</text>
      {directive && <text attributes={TextAttributes.DIM}>{`  directive: ${truncateText(directive)}`}</text>}
      {FORK_OPTIONS.map((opt, i) => {
        const on = i === selected
        return (
          <box key={opt.label} flexDirection="row">
            <text fg={on ? ACCENT : undefined}>{on ? "❯ " : "  "}</text>
            <text fg={on ? ACCENT : undefined} attributes={on ? TextAttributes.BOLD : 0}>
              {opt.label}
            </text>
          </box>
        )
      })}
      {busy && <text attributes={TextAttributes.DIM}>{"  forking…"}</text>}
      {error && <text fg={WARNING}>{`  ${error}`}</text>}
    </box>
  )
}
