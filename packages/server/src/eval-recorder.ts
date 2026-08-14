// Eval recorder: capture every sidekick handoff as an immutable candidate.
// Failures are swallowed — recording must never affect a delegation.
import {
  closeSync,
  createWriteStream,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { dirname, join } from "node:path"
import { createGzip } from "node:zlib"
import { once } from "node:events"
import { randomBytes } from "node:crypto"
import type { AgentEvent } from "@chunky/protocol"
import { isIncognitoSession } from "./incognito.ts"
import { stateDir } from "./repos.ts"
import { snapshotWorkspaceAsync } from "./shadow-git.ts"
import { getEvalsMode } from "./settings.ts"
import { Store } from "./store.ts"

export type EvalsMode = "off" | "record"

export interface EvalBriefStruct {
  task: string
  constraints?: string[]
  done_when?: string
  pointers?: string
  seat?: string
}

export interface EvalCandidateJson {
  delegationId: string
  sessionId: string
  seat?: string
  sidekickThreadId: string
  provider: string
  model: string
  effort?: string
  workspace: string
  briefStruct?: EvalBriefStruct
  briefComposed: string
  snapshotRef: string
  snapshot: string | null
  startedAt: number
  startSeq: number
}

export interface EvalReportJson {
  ok: boolean
  finalReport: string
  completedAt: number
  endSeq: number
}

export interface EvalRatingJson {
  compliance: number
  correctness: number
  report: number
  exceeded: number
  rework: boolean
  diagnosis?: string
  reason: string
  rating: number
  judgeProvider: string
  judgeModel: string
  ts: number
}

export function evalCandidateDir(delegationId: string): string {
  return join(stateDir(), "evals", "candidates", delegationId)
}

function candidatePath(delegationId: string, name: string): string {
  return join(evalCandidateDir(delegationId), name)
}

function safe(fn: () => void): void {
  try { fn() } catch { /* recording must never affect a run */ }
}

function writeOnceJson(path: string, value: unknown): boolean {
  if (existsSync(path)) return false
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`
  writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 })
  try {
    renameSync(temporary, path)
    return true
  } catch (err) {
    try { unlinkSync(temporary) } catch { /* ignore leftover tmp */ }
    if (existsSync(path)) return false
    throw err
  }
}

function shouldRecord(sessionId: string, workspace: string | null | undefined): workspace is string {
  if (getEvalsMode() !== "record") return false
  if (isIncognitoSession(sessionId)) return false
  if (!Store.exists(sessionId)) return false
  if (Store.repositoryScopeOf(sessionId) !== "repository") return false
  if (!workspace || Store.workspaceOf(sessionId) == null) return false
  return true
}

export function recordSidekickStart(opts: {
  delegationId: string
  sessionId: string
  seat?: string
  sidekickThreadId: string
  provider: string
  model: string
  effort?: string
  workspace: string
  briefStruct?: EvalBriefStruct
  briefComposed: string
}): void {
  safe(() => {
    if (!shouldRecord(opts.sessionId, opts.workspace)) return
    const snapshotRef = `refs/evals/${opts.delegationId}`
    const startSeq = Store.nextEventSeq(opts.sessionId)
    const candidate: EvalCandidateJson = {
      delegationId: opts.delegationId,
      sessionId: opts.sessionId,
      ...(opts.seat ? { seat: opts.seat } : {}),
      sidekickThreadId: opts.sidekickThreadId,
      provider: opts.provider,
      model: opts.model,
      ...(opts.effort ? { effort: opts.effort } : {}),
      workspace: opts.workspace,
      ...(opts.briefStruct ? { briefStruct: opts.briefStruct } : {}),
      briefComposed: opts.briefComposed,
      snapshotRef,
      snapshot: null,
      startedAt: Date.now(),
      startSeq,
    }
    if (!writeOnceJson(candidatePath(opts.delegationId, "candidate.json"), candidate)) return
    void snapshotWorkspaceAsync(opts.workspace, snapshotRef).then((snapshot) => {
      safe(() => patchCandidateSnapshot(opts.delegationId, snapshot))
    }).catch(() => { /* swallow */ })
  })
}

function patchCandidateSnapshot(delegationId: string, snapshot: string | null): void {
  const path = candidatePath(delegationId, "candidate.json")
  if (!existsSync(path)) return
  const current = JSON.parse(readFileSync(path, "utf8")) as EvalCandidateJson
  current.snapshot = snapshot
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`
  writeFileSync(temporary, JSON.stringify(current, null, 2), { mode: 0o600 })
  renameSync(temporary, path)
}

export function recordSidekickComplete(opts: {
  delegationId: string
  sessionId: string
  sidekickThreadId: string
  ok: boolean
  finalReport: string
}): void {
  safe(() => {
    const dir = evalCandidateDir(opts.delegationId)
    if (!existsSync(join(dir, "candidate.json"))) return
    const endSeq = Store.nextEventSeq(opts.sessionId)
    const report: EvalReportJson = {
      ok: opts.ok,
      finalReport: opts.finalReport,
      completedAt: Date.now(),
      endSeq,
    }
    writeOnceJson(join(dir, "report.json"), report)
    const candidate = JSON.parse(readFileSync(join(dir, "candidate.json"), "utf8")) as EvalCandidateJson
    void writeTranscriptSlice({
      sessionId: opts.sessionId,
      threadId: opts.sidekickThreadId,
      startSeq: candidate.startSeq,
      endSeq,
      dest: join(dir, "transcript.jsonl.gz"),
    }).catch(() => { /* swallow */ })
  })
}

async function writeTranscriptSlice(opts: {
  sessionId: string
  threadId: string
  startSeq: number
  endSeq: number
  dest: string
}): Promise<void> {
  if (existsSync(opts.dest)) return
  mkdirSync(dirname(opts.dest), { recursive: true })
  const rows = Store.historyWithSeq(opts.sessionId).filter((row) => {
    if (row.seq < opts.startSeq || row.seq >= opts.endSeq) return false
    const ev = row.event as AgentEvent & { threadId?: string }
    return ev.threadId === opts.threadId
  })
  const temp = `${opts.dest}.tmp-${process.pid}.${randomBytes(8).toString("hex")}`
  const gzip = createGzip()
  const output = createWriteStream(temp, { mode: 0o600 })
  gzip.pipe(output)
  for (const row of rows) {
    const line = JSON.stringify({ seq: row.seq, json: JSON.stringify(row.event) }) + "\n"
    if (!gzip.write(line)) await once(gzip, "drain")
  }
  gzip.end()
  await once(output, "close")
  const fd = openSync(temp, "r")
  fsyncSync(fd)
  closeSync(fd)
  try {
    renameSync(temp, opts.dest)
  } catch {
    try { unlinkSync(temp) } catch { /* ignore leftover tmp */ }
  }
}

export function recordSidekickRating(delegationId: string, rating: EvalRatingJson): void {
  safe(() => {
    const dir = evalCandidateDir(delegationId)
    if (!existsSync(join(dir, "candidate.json"))) return
    writeOnceJson(join(dir, "rating.json"), rating)
  })
}
