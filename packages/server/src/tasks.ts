import { randomUUID } from "node:crypto"
import { appendFileSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Subprocess } from "bun"
import { terminateProcessTree } from "./process-tree.ts"

export type TaskStatus = "running" | "completed" | "failed" | "cancelled"

export interface TaskSnapshot {
  taskId: string
  sessionId: string
  kind: "bash"
  command: string
  description?: string
  status: TaskStatus
  startedAt: number
  endedAt?: number
  exitCode?: number | null
  signal?: string
  output: string
  rawOutputBytes: number
  truncated: boolean
  spillPath: string
  isTerminal: boolean
  timedOut?: boolean
}

export type TaskRecord = TaskSnapshot & { process?: Subprocess; cancelRequested: boolean; done: Promise<void>; resolveDone: () => void; outputBytes: number }
const tasks = new Map<string, Map<string, TaskRecord>>()
const nextIds = new Map<string, number>()
const OUTPUT_CAP = 32 * 1024

function sessionTasks(sessionId: string) {
  let map = tasks.get(sessionId)
  if (!map) { map = new Map(); tasks.set(sessionId, map) }
  return map
}

export function createTask(sessionId: string, input: { command: string; description?: string; spillPath: string; process: Subprocess }): TaskRecord {
  const id = `task-${nextIds.get(sessionId) ?? 1}`
  nextIds.set(sessionId, (nextIds.get(sessionId) ?? 1) + 1)
  let resolveDone!: () => void
  const done = new Promise<void>((resolve) => { resolveDone = resolve })
  const record = {
    taskId: id, sessionId, kind: "bash" as const, command: input.command, description: input.description,
    status: "running" as const, startedAt: Date.now(), output: "", rawOutputBytes: 0, truncated: false,
    spillPath: input.spillPath, isTerminal: false, process: input.process, cancelRequested: false, done, resolveDone, outputBytes: 0,
  }
  const taskPath = input.spillPath.replace(/-task-/, `-${id}-`)
  if (taskPath !== input.spillPath) {
    try { renameSync(input.spillPath, taskPath); record.spillPath = taskPath } catch { /* retain the initialized path */ }
  }
  sessionTasks(sessionId).set(id, record)
  return record
}

export function appendTaskOutput(record: TaskRecord, chunk: string): void {
  appendFileSync(record.spillPath, chunk, "utf8")
  record.rawOutputBytes += Buffer.byteLength(chunk)
  const bytes = Buffer.from(chunk)
  const remaining = OUTPUT_CAP - record.outputBytes
  if (remaining > 0) {
    let preview = bytes.subarray(0, remaining)
    let text = preview.toString("utf8")
    while (preview.length && (text.includes("\ufffd") || Buffer.byteLength(text) > remaining)) {
      preview = preview.subarray(0, preview.length - 1)
      text = preview.toString("utf8")
    }
    record.output += text
  }
  record.outputBytes += Math.min(bytes.length, Math.max(remaining, 0))
  if (record.rawOutputBytes > OUTPUT_CAP) record.truncated = true
}

export function finishTask(record: TaskRecord, exitCode: number | null, signal?: string): void {
  if (record.isTerminal) return
  record.exitCode = exitCode
  record.signal = signal
  record.status = record.timedOut ? "failed" : record.cancelRequested ? "cancelled" : exitCode === 0 ? "completed" : "failed"
  record.endedAt = Date.now()
  record.isTerminal = true
  record.process = undefined
  record.resolveDone()
  const reminders = pendingReminders.get(record.sessionId) ?? []
  if (!reminders.includes(record.taskId) && reminders.length < 32) reminders.push(record.taskId)
  pendingReminders.set(record.sessionId, reminders)
}

export function snapshotTask(record: TaskRecord): TaskSnapshot {
  const { process: _process, cancelRequested: _cancel, done: _done, resolveDone: _resolve, outputBytes: _outputBytes, ...snapshot } = record
  return { ...snapshot }
}

export function getTaskRecord(sessionId: string, id: string): TaskRecord | undefined { return tasks.get(sessionId)?.get(id) }
/** Immutable metadata snapshots for live-state consumers. */
export function snapshotSessionTasks(sessionId: string): TaskSnapshot[] {
  return [...(tasks.get(sessionId)?.values() ?? [])].map(snapshotTask)
}
export async function waitTasks(sessionId: string, ids: string[], timeoutMs: number): Promise<void> {
  const records = ids.map((id) => getTaskRecord(sessionId, id)).filter((r): r is TaskRecord => !!r)
  if (!records.length || !timeoutMs) return
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      Promise.all(records.map((r) => r.done)),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, Math.min(timeoutMs, 600_000))
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
export function requestCancel(record: TaskRecord): void {
  if (!record.isTerminal) record.cancelRequested = true
}
export function markTaskTimedOut(record: TaskRecord): void {
  if (!record.isTerminal) { record.timedOut = true; record.cancelRequested = false }
}
export function consumeTaskReminder(sessionId: string, id: string): void {
  const reminders = pendingReminders.get(sessionId)
  if (!reminders) return
  const remaining = reminders.filter((taskId) => taskId !== id)
  if (remaining.length) pendingReminders.set(sessionId, remaining); else pendingReminders.delete(sessionId)
}
export function pendingTaskReminders(sessionId: string): string {
  const ids = pendingReminders.get(sessionId) ?? []
  pendingReminders.delete(sessionId)
  return ids.map((id) => {
    const record = getTaskRecord(sessionId, id)
    return record ? `Background task ${id} (${record.description ?? record.command}) is ${record.status}. Use get_task_output with task_ids=["${id}"] for output.` : ""
  }).filter(Boolean).join("\n")
}
export function peekTaskReminders(sessionId: string): { text: string; ids: string[] } {
  const ids = [...(pendingReminders.get(sessionId) ?? [])]
  return { ids, text: ids.map((id) => {
    const record = getTaskRecord(sessionId, id)
    return record ? `Background task ${id} (${record.description ?? record.command}) is ${record.status}. Use get_task_output with task_ids=["${id}"] for output.` : ""
  }).filter(Boolean).join("\n") }
}
export function consumeTaskReminders(sessionId: string, ids: string[]): void { for (const id of ids) consumeTaskReminder(sessionId, id) }
export async function cleanupSession(sessionId: string): Promise<void> {
  const map = tasks.get(sessionId)
  if (map) for (const record of map.values()) {
    if (!record.isTerminal) { requestCancel(record); if (record.process) terminateProcessTree(record.process.pid); await record.done }
    try { unlinkSync(record.spillPath) } catch {}
  }
  tasks.delete(sessionId); pendingReminders.delete(sessionId); nextIds.delete(sessionId)
}
export async function resetTasks(): Promise<void> { for (const id of [...tasks.keys()]) await cleanupSession(id) }
export const taskOutputCap = OUTPUT_CAP
export function taskSpillPath(sessionId: string, taskId = "task"): string {
  const path = join("/tmp", `chunky-bash-${sessionId}-${taskId}-${randomUUID()}.txt`)
  writeFileSync(path, "", "utf8")
  return path
}
const pendingReminders = new Map<string, string[]>()
