import { describe, expect, test } from "bun:test"
import { updateTodos, todoSummary, type TodoSnapshot } from "./todos.ts"
import { Store } from "./store.ts"

describe("todos", () => {
  test("replace preserves order and generates ids", () => {
    const result = updateTodos([], "replace", [
      { content: "first", status: "pending" },
      { content: "second", status: "in_progress", assignee: "backend" },
    ])
    expect(result.error).toBeUndefined()
    expect(result.todos?.map((todo) => todo.content)).toEqual(["first", "second"])
    expect(result.todos?.every((todo) => todo.id.length > 0)).toBe(true)
    expect(todoSummary(result.todos!)).toContain("→ second [backend]")
  })

  test("merge is atomic and preserves list order", () => {
    const current: TodoSnapshot[] = [
      { id: "a", content: "A", status: "pending" },
      { id: "b", content: "B", status: "in_progress" },
    ]
    const changed = updateTodos(current, "merge", [{ id: "b", status: "completed", content: "done" }])
    expect(changed.todos).toEqual([current[0], { id: "b", content: "done", status: "completed" }])
    const rejected = updateTodos(current, "merge", [{ id: "missing", status: "completed" }, { id: "a", status: "completed" }])
    expect(rejected.error).toContain("unknown todo id")
    expect(rejected.todos).toBeUndefined()
  })

  test("store round-trips todos", () => {
    const sessionId = `todo-test-${crypto.randomUUID()}`
    const todos: TodoSnapshot[] = [{ id: "a", content: "persist", status: "completed" }]
    Store.putTodos(sessionId, todos)
    expect(Store.getTodos(sessionId)).toEqual(todos)
    Store.clearTodos(sessionId)
    expect(Store.getTodos(sessionId)).toEqual([])
  })
})
