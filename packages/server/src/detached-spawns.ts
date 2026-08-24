// Session-scoped lifecycle state for detached spawn_thread children. This is
// intentionally separate from tasks.ts: agent streams are abort-controller based,
// not subprocesses, and their result is an agent report rather than shell output.
import { randomUUID } from "node:crypto"
import { notifySessionChanged } from "./session-changes.ts"

export type DetachedSpawnStatus = "running" | "completed" | "failed" | "cancelled"

export interface DetachedSpawnRecord {
  id: string
  sessionId: string
  childThreadId: string
  title: string
  status: DetachedSpawnStatus
  startedAt: number
  endedAt?: number
  result?: string
  kind?: "sidekick" | "spawn_thread" | "workflow"
  seat?: string
  abort: AbortController
  done: Promise<void>
  resolveDone: () => void
}

export interface DetachedSpawnMeta {
  kind?: "sidekick" | "spawn_thread" | "workflow"
  seat?: string
}

const recordsBySession = new Map<string, Map<string, DetachedSpawnRecord>>()
const MAX_RUNNING_PER_SESSION = 8
const COMPLETED_TTL_MS = 30 * 60_000
const RESULT_CAP = 64 * 1024

function capResult(text: string): string {
  const suffix = "\n[detached report truncated]"
  const bytes = Buffer.from(text)
  if (bytes.length <= RESULT_CAP) return text
  let body = bytes.subarray(0, Math.max(0, RESULT_CAP - Buffer.byteLength(suffix))).toString("utf8")
  while (Buffer.byteLength(body) + Buffer.byteLength(suffix) > RESULT_CAP) body = body.slice(0, -1)
  return body + suffix
}

function sweepFinished(now = Date.now()): void {
  for (const [sessionId, records] of recordsBySession) {
    for (const [id, record] of records) {
      if (record.status !== "running" && record.endedAt !== undefined && now - record.endedAt >= COMPLETED_TTL_MS) records.delete(id)
    }
    if (!records.size) recordsBySession.delete(sessionId)
  }
}

function sessionRecords(sessionId: string): Map<string, DetachedSpawnRecord> {
  let records = recordsBySession.get(sessionId)
  if (!records) { records = new Map(); recordsBySession.set(sessionId, records) }
  return records
}

export function detachedSpawnLimit(): number { return MAX_RUNNING_PER_SESSION }
export function runningDetachedSpawnCount(sessionId: string): number {
  sweepFinished()
  return [...(recordsBySession.get(sessionId)?.values() ?? [])].filter((record) => record.status === "running").length
}

export function sweepDetachedSpawnsForTests(now: number): void { sweepFinished(now) }
export const detachedSpawnResultCap = RESULT_CAP

export function hasRunningDetachedSpawns(sessionId: string): boolean {
  return runningDetachedSpawnCount(sessionId) > 0
}

export function createDetachedSpawn(sessionId: string, childThreadId: string, title: string, force = false, meta?: DetachedSpawnMeta): DetachedSpawnRecord | undefined {
  sweepFinished()
  if (!force && runningDetachedSpawnCount(sessionId) >= MAX_RUNNING_PER_SESSION) return undefined
  let resolveDone!: () => void
  const done = new Promise<void>((resolve) => { resolveDone = resolve })
  const record: DetachedSpawnRecord = {
    id: randomUUID(), sessionId, childThreadId, title, status: "running", startedAt: Date.now(),
    abort: new AbortController(), done, resolveDone,
    ...(meta?.kind ? { kind: meta.kind } : {}),
    ...(meta?.seat ? { seat: meta.seat } : {}),
  }
  sessionRecords(sessionId).set(record.id, record)
  // A detached spawn counts toward the session's `busy`, which the compact
  // session stream publishes; tell it the state changed.
  notifySessionChanged(sessionId)
  return record
}

export function isCancelledDelegateReport(text: string): boolean {
  return /^(?:error:\s*)?cancelled by (?:user|lead)\b/i.test(text.trim())
}

export function finishDetachedSpawn(record: DetachedSpawnRecord, result: string): void {
  if (record.status !== "running") return
  record.result = capResult(result)
  record.endedAt = Date.now()
  // Abort wins over an error: prefix so a user/lead stop is cancelled, not failed.
  record.status = record.abort.signal.aborted || isCancelledDelegateReport(result)
    ? "cancelled"
    : result.startsWith("error:") ? "failed" : "completed"
  record.resolveDone()
  notifySessionChanged(record.sessionId)
}

export function getDetachedSpawn(sessionId: string, id: string): DetachedSpawnRecord | undefined {
  sweepFinished()
  return recordsBySession.get(sessionId)?.get(id)
}

export function listDetachedSpawns(sessionId: string): DetachedSpawnRecord[] {
  sweepFinished()
  return [...(recordsBySession.get(sessionId)?.values() ?? [])]
}

/** Abort a running detached record. Idempotent: a settled record is already-finished. */
export function abortDetachedSpawn(record: DetachedSpawnRecord, reason = "cancelled by user"): "cancelled" | "already-finished" {
  if (record.status !== "running") return "already-finished"
  record.abort.abort(new Error(reason))
  return "cancelled"
}

export function runningDetachedSpawnSummaries(sessionId: string): Array<{ id: string; title: string; status: DetachedSpawnStatus }> {
  sweepFinished()
  return [...(recordsBySession.get(sessionId)?.values() ?? [])]
    .filter((record) => record.status === "running")
    .map(({ id, title, status }) => ({ id, title, status }))
}

/** Server-shutdown cleanup. Detached streams have their own controllers, so they
 * are not coupled to the root turn's abort controller. */
export async function resetDetachedSpawns(): Promise<void> {
  const records = [...recordsBySession.values()].flatMap((session) => [...session.values()])
  for (const record of records) if (record.status === "running") record.abort.abort("server shutdown")
  await Promise.all(records.filter((record) => record.status === "running").map((record) => record.done))
  recordsBySession.clear()
}
