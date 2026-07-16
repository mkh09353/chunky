import { tool } from "@langchain/core/tools"
import { z } from "zod"
import { consumeTaskReminder, getTaskRecord, requestCancel, snapshotTask, waitTasks } from "../tasks.ts"
import { toolResult } from "./result.ts"
import { sessionForThread } from "../thread-context.ts"
import { terminateProcessTree } from "../process-tree.ts"

export const getTaskOutputInputShape = { task_ids: z.array(z.string()).min(1), timeout_ms: z.number().nonnegative().optional() }
export const killTaskInputShape = { task_id: z.string() }

function session(config: any): string {
  const threadId = config?.configurable?.thread_id
  return sessionForThread(threadId) ?? threadId ?? "unknown"
}

function display(snapshot: ReturnType<typeof snapshotTask>) {
  return {
    task_id: snapshot.taskId, status: snapshot.status, is_terminal: snapshot.isTerminal,
    started_at: snapshot.startedAt, ...(snapshot.endedAt !== undefined ? { ended_at: snapshot.endedAt } : {}),
    exit_code: snapshot.exitCode, signal: snapshot.signal, output: snapshot.output,
    raw_output_bytes: snapshot.rawOutputBytes, truncated: snapshot.truncated,
    ...(snapshot.timedOut ? { timed_out: true } : {}),
    ...(snapshot.spillPath ? { spill_path: snapshot.spillPath, reread_hint: `Use bash with \`cat ${snapshot.spillPath}\` for full output.` } : {}),
  }
}

export const getTaskOutput = tool(
  async ({ task_ids, timeout_ms }: { task_ids: string[]; timeout_ms?: number }, config?: any) => {
    const owner = session(config)
    await waitTasks(owner, task_ids, timeout_ms ?? 0)
    const results = task_ids.map((id) => {
      const record = getTaskRecord(owner, id)
      if (!record) return { task_id: id, status: "not_found", is_terminal: true, output: "Task not found." }
      consumeTaskReminder(owner, id)
      return display(snapshotTask(record))
    })
    return toolResult(results.map((r) => `${r.task_id}: ${r.status}${r.output ? ` — ${r.output.slice(0, 500)}` : ""}`).join("\n"), { raw: { kind: "task-output", results } })
  },
  { name: "get_task_output", description: "Poll background bash tasks; omitted or 0 timeout is nonblocking, positive timeout waits for all known tasks (capped at 600000ms).", schema: z.object(getTaskOutputInputShape) },
)

export const killTask = tool(
  async ({ task_id }: { task_id: string }, config?: any) => {
    const record = getTaskRecord(session(config), task_id)
    if (!record) return toolResult(`Task ${task_id} not found.`, { ok: false, raw: { task_id, outcome: "not_found" } })
    if (record.isTerminal) return toolResult(`Task ${task_id} already exited (${record.status}).`, { raw: { task_id, outcome: "already_exited", status: record.status } })
    requestCancel(record)
    consumeTaskReminder(session(config), task_id)
    if (record.process) {
      terminateProcessTree(record.process.pid)
    }
    await record.done
    return toolResult(`Task ${task_id} killed.`, { raw: { task_id, outcome: "killed", status: record.status } })
  },
  { name: "kill_task", description: "Kill a running background bash task by task ID.", schema: z.object(killTaskInputShape) },
)
