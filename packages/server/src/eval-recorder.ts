// Eval recorder: capture every sidekick handoff as an immutable candidate.
// Failures are swallowed — recording must never affect a delegation.
import {
  closeSync,
  cpSync,
  createWriteStream,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { dirname, join } from "node:path"
import { createGzip, gunzipSync } from "node:zlib"
import { once } from "node:events"
import { randomBytes } from "node:crypto"
import type {
  AgentEvent,
  EvalBriefStruct,
  EvalCandidateDetailResponse,
  EvalCandidateJson,
  EvalCandidateSummary,
  EvalPromoteBucket,
  EvalRatingJson,
  EvalReportJson,
  EvalsResponse,
  EvalsStats,
} from "@chunky/protocol"
import { isIncognitoSession } from "./incognito.ts"
import { stateDir } from "./repos.ts"
import { snapshotWorkspaceAsync } from "./shadow-git.ts"
import { getEvalsMode } from "./settings.ts"
import { Store } from "./store.ts"

export type { EvalBriefStruct, EvalCandidateJson, EvalRatingJson, EvalReportJson }

export class EvalRecorderError extends Error {
  readonly status: 404 | 409
  constructor(status: 404 | 409, message: string) {
    super(message)
    this.name = "EvalRecorderError"
    this.status = status
  }
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

export function evalsRoot(): string {
  return join(stateDir(), "evals")
}

export function evalSuiteDir(delegationId: string): string {
  return join(evalsRoot(), "suite", delegationId)
}

function assertSafeEvalId(id: string): string {
  if (!id || id.includes("/") || id.includes("\\") || id.includes("..") || id.includes("\0")) {
    throw new EvalRecorderError(404, "unknown candidate")
  }
  return id
}

function readJsonIfPresent<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T
  } catch {
    return undefined
  }
}

export function isEvalCandidatePromoted(delegationId: string): boolean {
  return existsSync(evalSuiteDir(delegationId))
}

export function discardSidekickCandidate(delegationId: string): void {
  safe(() => {
    const dir = evalCandidateDir(delegationId)
    if (!existsSync(dir)) return
    if (isEvalCandidatePromoted(delegationId)) return
    rmSync(dir, { recursive: true, force: true })
  })
}


function summarizeCandidate(dir: string, id: string): EvalCandidateSummary | null {
  const candidate = readJsonIfPresent<EvalCandidateJson>(join(dir, "candidate.json"))
  if (!candidate || typeof candidate.delegationId !== "string" || typeof candidate.sessionId !== "string") {
    return null
  }
  if (typeof candidate.provider !== "string" || typeof candidate.model !== "string") return null
  if (typeof candidate.startedAt !== "number") return null
  const report = readJsonIfPresent<EvalReportJson>(join(dir, "report.json"))
  const rating = readJsonIfPresent<EvalRatingJson>(join(dir, "rating.json"))
  const promotion = readPromotionMeta(id)
  const task = candidate.briefStruct?.task
    ?? (typeof candidate.briefComposed === "string" ? candidate.briefComposed.slice(0, 200) : "")
  return {
    delegationId: candidate.delegationId,
    sessionId: candidate.sessionId,
    ...(candidate.seat ? { seat: candidate.seat } : {}),
    provider: candidate.provider,
    model: candidate.model,
    task,
    startedAt: candidate.startedAt,
    ...(report && typeof report.ok === "boolean" ? { ok: report.ok } : {}),
    ...(rating && typeof rating.rating === "number" ? { rating: rating.rating } : {}),
    ...(rating && typeof rating.rework === "boolean" ? { rework: rating.rework } : {}),
    ...(rating?.diagnosis ? { diagnosis: rating.diagnosis } : {}),
    promoted: promotion !== undefined,
    ...(promotion?.bucket ? { promotedBucket: promotion.bucket } : {}),
    ...(promotion?.promotedAt !== undefined ? { promotedAt: promotion.promotedAt } : {}),
  }
}

function readPromotionMeta(id: string): { bucket?: EvalPromoteBucket; promotedAt?: number } | undefined {
  if (!isEvalCandidatePromoted(id)) return undefined
  const raw = readJsonIfPresent<{ bucket?: unknown; promotedAt?: unknown }>(join(evalSuiteDir(id), "promoted.json"))
  const bucket = raw?.bucket === "hard" || raw?.bucket === "regression" || raw?.bucket === "random" ? raw.bucket : undefined
  const promotedAt = typeof raw?.promotedAt === "number" ? raw.promotedAt : undefined
  return { ...(bucket ? { bucket } : {}), ...(promotedAt !== undefined ? { promotedAt } : {}) }
}

function directorySize(path: string): number {
  let total = 0
  let entries
  try { entries = readdirSync(path, { withFileTypes: true }) } catch { return 0 }
  for (const entry of entries) {
    const full = join(path, entry.name)
    try {
      if (entry.isDirectory()) total += directorySize(full)
      else total += statSync(full).size
    } catch { /* skip unreadable entries */ }
  }
  return total
}

export function evalsStats(): EvalsStats {
  const root = evalsRoot()
  const candidatesRoot = join(root, "candidates")
  const suiteRoot = join(root, "suite")
  let candidates = 0
  try {
    for (const entry of readdirSync(candidatesRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(join(candidatesRoot, entry.name, "candidate.json"))) candidates++
    }
  } catch { /* no candidates yet */ }
  let promoted = 0
  try {
    for (const entry of readdirSync(suiteRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) promoted++
    }
  } catch { /* no suite yet */ }
  return { candidates, promoted, bytes: directorySize(root) }
}

export function evalsResponse(mode: EvalsResponse["mode"]): EvalsResponse {
  return { mode, stats: evalsStats() }
}

export function listEvalCandidates(): EvalCandidateSummary[] {
  const root = join(evalsRoot(), "candidates")
  let entries
  try { entries = readdirSync(root, { withFileTypes: true }) } catch { return [] }
  const rows: EvalCandidateSummary[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const row = summarizeCandidate(join(root, entry.name), entry.name)
    if (row) rows.push(row)
  }
  rows.sort((a, b) => b.startedAt - a.startedAt || b.delegationId.localeCompare(a.delegationId))
  return rows
}

export function getEvalCandidateDetail(id: string): EvalCandidateDetailResponse {
  const safe = assertSafeEvalId(id)
  const dir = evalCandidateDir(safe)
  const candidate = readJsonIfPresent<EvalCandidateJson>(join(dir, "candidate.json"))
  if (!candidate) throw new EvalRecorderError(404, "unknown candidate")
  const report = readJsonIfPresent<EvalReportJson>(join(dir, "report.json"))
  const rating = readJsonIfPresent<EvalRatingJson>(join(dir, "rating.json"))
  const promotion = readPromotionMeta(safe)
  return {
    candidate,
    ...(report ? { report } : {}),
    ...(rating ? { rating } : {}),
    promoted: promotion !== undefined,
    ...(promotion?.bucket ? { promotedBucket: promotion.bucket } : {}),
    ...(promotion?.promotedAt !== undefined ? { promotedAt: promotion.promotedAt } : {}),
  }
}

export function readEvalTranscript(id: string): string {
  const safe = assertSafeEvalId(id)
  const path = join(evalCandidateDir(safe), "transcript.jsonl.gz")
  if (!existsSync(path)) throw new EvalRecorderError(404, "transcript not found")
  return gunzipSync(readFileSync(path)).toString("utf8")
}

export function promoteEvalCandidate(id: string, bucket?: EvalPromoteBucket): EvalCandidateDetailResponse {
  const safe = assertSafeEvalId(id)
  const src = evalCandidateDir(safe)
  if (!existsSync(join(src, "candidate.json"))) throw new EvalRecorderError(404, "unknown candidate")
  const dest = evalSuiteDir(safe)
  if (existsSync(dest)) throw new EvalRecorderError(409, "already promoted")
  mkdirSync(dirname(dest), { recursive: true })
  const temporary = `${dest}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`
  try {
    cpSync(src, temporary, { recursive: true })
    const promoted = {
      ...(bucket ? { bucket } : {}),
      promotedAt: Date.now(),
    }
    writeFileSync(join(temporary, "promoted.json"), JSON.stringify(promoted, null, 2), { mode: 0o600 })
    renameSync(temporary, dest)
  } catch (err) {
    try { rmSync(temporary, { recursive: true, force: true }) } catch { /* leftover tmp */ }
    if (existsSync(dest)) throw new EvalRecorderError(409, "already promoted")
    throw err
  }
  return getEvalCandidateDetail(safe)
}

export function deleteEvalCandidate(id: string): void {
  const safe = assertSafeEvalId(id)
  const dir = evalCandidateDir(safe)
  if (!existsSync(dir)) throw new EvalRecorderError(404, "unknown candidate")
  if (isEvalCandidatePromoted(safe)) throw new EvalRecorderError(409, "promoted")
  rmSync(dir, { recursive: true, force: true })
}
