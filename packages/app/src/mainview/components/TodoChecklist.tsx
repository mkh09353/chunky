import { useState } from "react"
import type { TodoSnapshot, TodoStatus } from "@chunky/protocol"

/** Status marker glyphs — mirrors the TUI's checklist vocabulary. */
const MARKER: Record<TodoStatus, string> = {
  pending: "○",
  in_progress: "◐",
  completed: "✓",
  cancelled: "✕",
}

/** The line shown on the collapsed pill: whatever is in flight (its activeForm
 *  when the agent supplied one), else nothing — the count alone carries it. */
function currentLabel(todos: TodoSnapshot[]): string | null {
  const active = todos.find((t) => t.status === "in_progress")
  if (!active) return null
  return active.activeForm || active.content
}

/** Read-only session checklist in the composer footer. Collapsed to a progress
 *  pill by default (alongside the goal pill); click to expand the full list.
 *  Renders NOTHING when the session has no todos. */
export function TodoChecklist({ todos }: { todos: TodoSnapshot[] }) {
  const [open, setOpen] = useState(false)
  if (todos.length === 0) return null

  const done = todos.filter((t) => t.status === "completed").length
  const label = currentLabel(todos)

  return (
    <span className="chunky-todo-wrap">
      <button
        type="button"
        className="chunky-status-pill chunky-todo-pill"
        aria-expanded={open}
        title={label || `${done}/${todos.length} todos complete`}
        onClick={() => setOpen((v) => !v)}
      >
        Todos {done}/{todos.length}
        {label ? <span className="chunky-todo-current">{label}</span> : null}
      </button>
      {open ? (
        <div className="chunky-todo-panel" role="list">
          {todos.map((todo) => (
            <div className="chunky-todo-item" role="listitem" data-status={todo.status} key={todo.id}>
              <span className="chunky-todo-marker" aria-hidden="true">
                {MARKER[todo.status]}
              </span>
              <span className="chunky-todo-text">
                {todo.status === "in_progress" && todo.activeForm ? todo.activeForm : todo.content}
              </span>
              {todo.assignee ? <span className="chunky-todo-assignee">{todo.assignee}</span> : null}
            </div>
          ))}
        </div>
      ) : null}
    </span>
  )
}
