import { useEffect, useRef, useState } from "react"
import { THREAD_TITLE_MAX } from "../lib/api"

/**
 * In-place rename box for a sidebar thread row, rendered INSTEAD of its
 * SideNavItem while editing.
 *
 * In-place rather than a modal: renaming is a small correction to a label you're
 * looking at, and a modal would rip that context away for one field.
 *
 * Enter or blur commits, Escape cancels. `maxLength` matches the server's cap so
 * the box can't hold a title longer than what gets stored.
 */
export function ThreadRenameInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string
  onCommit: (next: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState(initial)
  const inputRef = useRef<HTMLInputElement>(null)
  // Enter commits and unmounts this input — but a commit via blur can race the
  // same path (e.g. Enter moves focus). Latch so the rename fires exactly once.
  const settledRef = useRef(false)

  useEffect(() => {
    inputRef.current?.focus()
    // Select-all: the common case is replacing an auto-generated title outright,
    // and any keystroke still just overwrites it.
    inputRef.current?.select()
  }, [])

  const settle = (fn: () => void) => {
    if (settledRef.current) return
    settledRef.current = true
    fn()
  }

  return (
    <input
      ref={inputRef}
      className="chunky-thread-rename"
      type="text"
      value={value}
      maxLength={THREAD_TITLE_MAX}
      spellCheck={false}
      aria-label="Rename thread"
      placeholder="Thread name…"
      onChange={(e) => setValue(e.target.value)}
      // Keep keys local: the app binds document-level shortcuts (Cmd+1…9 repo
      // tabs, Ctrl+T fold threads), and typing a title must not trigger them.
      // React roots its listeners at #root, so stopping here also stops those.
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === "Enter") {
          e.preventDefault()
          settle(() => onCommit(value))
        } else if (e.key === "Escape") {
          e.preventDefault()
          settle(onCancel)
        }
      }}
      onBlur={() => settle(() => onCommit(value))}
    />
  )
}
