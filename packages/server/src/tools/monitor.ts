import { tool } from "@langchain/core/tools"
import { z } from "zod"
import { workspaceFromConfig } from "../workspace.ts"
import { appendReminder, appendBufferedTaskOutput, countMonitors, createTask, finishTask, floodExceeded, markTaskFailed, monitorLines, taskSpillPath } from "../tasks.ts"
import { routeBackgroundNotice } from "../background-dispatch.ts"
import { sessionForThread } from "../thread-context.ts"
import { terminateProcessTree } from "../process-tree.ts"
import { toolResult } from "./result.ts"

export const monitorInputShape = {
  command: z.string(), description: z.string(), max_events_per_minute: z.number().positive().optional(),
}

export const monitor = tool(async ({ command, description, max_events_per_minute = 30 }: { command: string; description: string; max_events_per_minute?: number }, config?: any) => {
  const threadId = config?.configurable?.thread_id
  const sessionId = sessionForThread(threadId) ?? threadId
  if (!sessionId) return toolResult("Monitors require an active session.", { ok: false })
  if (countMonitors(sessionId) >= 10) return toolResult("Monitor limit reached (10 per session).", { ok: false })
  const proc = Bun.spawn(["bash", "-lc", command], { cwd: workspaceFromConfig(config), stdout: "pipe", stderr: "pipe" })
  const record = createTask(sessionId, { command, description, spillPath: taskSpillPath(sessionId, "mon"), process: proc, kind: "monitor" })
  let partial = "", buffered = "", timer: ReturnType<typeof setTimeout> | undefined, times: number[] = [], flooded = false
  const flush = () => {
    timer = undefined
    if (!buffered || flooded) return
    const lines = buffered; buffered = ""
    const count = lines.split("\n").filter(Boolean).length
    const text = `Monitor ${record.taskId} (${description}) emitted ${count} new lines:\n${lines}`
    if (routeBackgroundNotice(sessionId, text, text) === "reminder") appendReminder(sessionId, text)
  }
  const receive = (chunk: string) => {
    appendBufferedTaskOutput(record, chunk)
    const split = monitorLines(chunk, partial); partial = split.pending
    for (const line of split.lines) {
      const state = floodExceeded(times, Date.now(), max_events_per_minute); times = state.times
      if (state.exceeded) {
        flooded = true; markTaskFailed(record); terminateProcessTree(proc.pid)
        const text = `Monitor ${record.taskId} stopped: too many events (${times.length}/min). Restart with a tighter filter (grep --line-buffered).`
        if (routeBackgroundNotice(sessionId, text, text) === "reminder") appendReminder(sessionId, text)
        return
      }
      buffered += (buffered ? "\n" : "") + line
    }
    if (buffered && !timer) timer = setTimeout(flush, 2000)
  }
  const readers = [proc.stdout.getReader(), proc.stderr.getReader()]
  const read = async (reader: ReadableStreamDefaultReader<Uint8Array>) => { const decoder = new TextDecoder(); try { while (true) { const { done, value } = await reader.read(); if (done) break; receive(decoder.decode(value, { stream: true })) }; const tail = decoder.decode(); if (tail) receive(tail) } finally { reader.releaseLock() } }
  void (async () => { const reads = readers.map(read); const exit = await proc.exited; await Promise.allSettled(reads); if (partial) { buffered += (buffered ? "\n" : "") + partial; partial = "" }; if (timer) { clearTimeout(timer); flush() }; finishTask(record, exit) })().catch(() => finishTask(record, null))
  return toolResult(`Started monitor ${record.taskId}. Use get_task_output to poll it.`, { raw: { task_id: record.taskId } })
}, { name: "monitor", description: "Run an ongoing background watcher. Its output is coalesced and wakes the session when idle; use background bash with ready_pattern for a one-time dev-server-ready notification.", schema: z.object(monitorInputShape) })
