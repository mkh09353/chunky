import { tool } from "@langchain/core/tools"
import { z } from "zod"
import { Store } from "../store.ts"
import { sessionForThread } from "../thread-context.ts"
import { emitToSession } from "../session-bus.ts"
import { todoSummary, updateTodos as applyTodos, type TodoUpdate } from "../todos.ts"

function threadIdOf(config: unknown): string | undefined { return (config as any)?.configurable?.thread_id as string | undefined }

const item = z.object({
  id: z.string().optional(), content: z.string().optional(),
  status: z.enum(["pending", "in_progress", "completed", "cancelled"]).optional(),
  assignee: z.string().optional(), activeForm: z.string().optional(),
})
export const updateTodos = tool(
  async ({ mode, todos }: { mode: "replace" | "merge"; todos: TodoUpdate[] }, config?: unknown) => {
    const threadId = threadIdOf(config)
    const sessionId = sessionForThread(threadId)
    if (!sessionId) return "error: update_todos is only available inside an active lead session run."
    if (threadId !== sessionId) return "error: update_todos is only available to the lead agent."
    const result = applyTodos(Store.getTodos(sessionId), mode, todos)
    if (result.error) return `error: ${result.error}`
    Store.putTodos(sessionId, result.todos!)
    emitToSession(sessionId, { type: "todos.update", sessionId, todos: result.todos! })
    return `Todos updated (${mode}).\n${todoSummary(result.todos!)}`
  },
  { name: "update_todos", description: "Create or update the session todo list. Use replace for a complete list and merge for status or field updates by id.", schema: z.object({ mode: z.enum(["replace", "merge"]).default("replace"), todos: z.array(item) }) },
)
