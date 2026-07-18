import type { TodoSnapshot, TodoStatus } from "@chunky/protocol"

export type { TodoSnapshot, TodoStatus } from "@chunky/protocol"
export type TodoUpdate = { id?: string; content?: string; status?: TodoStatus; assignee?: string; activeForm?: string }

const statuses = new Set<TodoStatus>(["pending", "in_progress", "completed", "cancelled"])
const shortId = () => Math.random().toString(36).slice(2, 8)

export function todoSummary(todos: TodoSnapshot[]): string {
  return todos.map((t) => `${t.status === "completed" ? "✓" : t.status === "cancelled" ? "✗" : t.status === "in_progress" ? "→" : "○"} ${t.content}${t.assignee ? ` [${t.assignee}]` : ""}`).join("\n")
}

function validStatus(status: unknown): status is TodoStatus { return typeof status === "string" && statuses.has(status as TodoStatus) }
function text(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string`)
  return value.trim()
}

export function updateTodos(current: TodoSnapshot[], mode: "replace" | "merge", updates: TodoUpdate[]): { todos?: TodoSnapshot[]; error?: string } {
  try {
    if (mode === "replace") {
      const seen = new Set<string>()
      const todos = updates.map((u) => {
        const id = text(u.id, "id") ?? shortId()
        const content = text(u.content, "content")
        if (!content) throw new Error("content is required in replace mode")
        if (!validStatus(u.status)) throw new Error(`invalid todo status: ${String(u.status)}`)
        if (seen.has(id)) throw new Error(`duplicate todo id: ${id}`)
        seen.add(id)
        return { id, content, status: u.status, assignee: text(u.assignee, "assignee"), activeForm: text(u.activeForm, "activeForm") }
      })
      return { todos }
    }
    const byId = new Map(current.map((t) => [t.id, t]))
    for (const u of updates) {
      if (!u.id || !byId.has(u.id)) throw new Error(`unknown todo id in merge mode: ${u.id ?? "(missing)"}`)
      if (u.status !== undefined && !validStatus(u.status)) throw new Error(`invalid todo status: ${String(u.status)}`)
      const old = byId.get(u.id)!
      const content = u.content === undefined ? old.content : text(u.content, "content")!
      byId.set(u.id, { ...old, content, status: u.status ?? old.status, ...(u.assignee !== undefined ? { assignee: text(u.assignee, "assignee") } : {}), ...(u.activeForm !== undefined ? { activeForm: text(u.activeForm, "activeForm") } : {}) })
    }
    return { todos: current.map((t) => byId.get(t.id)!) }
  } catch (err) { return { error: (err as Error).message } }
}
