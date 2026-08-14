// Same-process workflow journal. A JournalingHost decorator wraps an injected
// WorkflowHost so engine.ts stays unit-testable without ThreadManager.
//
// Matching strategy (parallel-safe):
//   - Only result-bearing agent() calls are journaled (phase/log/parallel
//     structure is not). Schema retries stay inside one agent() call; the
//     journaled value is the script-visible result (text, parsed object, or null).
//   - Sequence numbers are assigned at request time (when agent() is invoked),
//     not when the child finishes. Concurrent parallel() completions therefore
//     cannot reorder the logical call stream.
//   - On resume, each new agent() call is matched against the journaled entry
//     at that request-time seq by SHA-256(request). A hash/kind mismatch is a
//     hard divergence error — never a silent live re-run. Exhausted journal
//     (seq past the last committed entry) continues live and appends.
//   - Disk appends stay dense: an out-of-order completion is held until every
//     earlier seq has committed. That way a later resume still sees 0..n-1.
//
// Resume is same-process only and not exactly-once: an in-flight agent that
// never committed may re-run. Successful runs keep the journal so the same
// run id can still be inspected; failed/errored runs always leave it on disk.
import { createHash } from "node:crypto"
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { stateDir } from "../repos.ts"
import type { AgentOpts, WorkflowHost } from "./engine.ts"

export const MAX_JOURNAL_ENTRIES = 10_000
export const MAX_JOURNAL_BYTES = 64 * 1024 * 1024

const HEADER_KIND = "header"
const AGENT_KIND = "agent"

export class WorkflowJournalError extends Error {
  readonly code: "divergence" | "header" | "full" | "missing" | "parse"
  constructor(code: WorkflowJournalError["code"], message: string) {
    super(message)
    this.name = "WorkflowJournalError"
    this.code = code
  }
}

export interface JournalHeader {
  v: 1
  kind: typeof HEADER_KIND
  runId: string
  scriptHash: string
  argsHash: string
  /** Present when the run was launched by saved workflow name. Resume still
   *  keys off scriptHash — an edited saved file diverges even if the name matches. */
  workflowName?: string
}

export interface JournalAgentEntry {
  seq: number
  kind: typeof AGENT_KIND
  reqHash: string
  result: unknown
}

export type JournalRecord = JournalHeader | JournalAgentEntry

export function fingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex")
}

export function requestHash(prompt: string, opts: AgentOpts): string {
  return fingerprint({
    prompt,
    opts: {
      label: opts.label,
      phase: opts.phase,
      tier: opts.tier,
      tags: opts.tags,
      provider: opts.provider,
      model: opts.model,
      effort: opts.effort,
      speed: opts.speed,
      schema: opts.schema,
    },
  })
}

export function workflowJournalDir(runId: string, baseDir = stateDir()): string {
  return join(baseDir, "workflows", sanitizeRunId(runId))
}

export function workflowJournalPath(runId: string, baseDir = stateDir()): string {
  return join(workflowJournalDir(runId, baseDir), "journal.jsonl")
}

function sanitizeRunId(runId: string): string {
  const cleaned = runId.replace(/[^A-Za-z0-9._-]/g, "")
  if (!cleaned) throw new WorkflowJournalError("parse", "workflow journal run id is empty")
  return cleaned
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

function canonicalize(value: unknown): unknown {
  if (value === undefined) return null
  if (value === null || typeof value !== "object") return value
  if (Array.isArray(value)) return value.map(canonicalize)
  const rec = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(rec).sort()) out[key] = canonicalize(rec[key])
  return out
}

export interface LoadedJournal {
  header: JournalHeader
  entries: JournalAgentEntry[]
  bytes: number
}

export function loadWorkflowJournal(runId: string, baseDir = stateDir()): LoadedJournal {
  const path = workflowJournalPath(runId, baseDir)
  if (!existsSync(path)) {
    throw new WorkflowJournalError("missing", `no workflow journal for run ${runId} — it may have been incognito or already gone`)
  }
  const raw = readFileSync(path, "utf8")
  const lines = raw.split(/\n/)
  let header: JournalHeader | undefined
  const entries: JournalAgentEntry[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim()
    if (!line) continue
    let parsed: JournalRecord
    try {
      parsed = JSON.parse(line) as JournalRecord
    } catch {
      // Torn tail from a crash mid-write: drop it and stop. Resume continues live.
      break
    }
    if (!header) {
      if ((parsed as JournalHeader).kind !== HEADER_KIND) {
        throw new WorkflowJournalError("parse", `workflow journal ${runId} is missing its header`)
      }
      header = parsed as JournalHeader
      continue
    }
    const entry = parsed as JournalAgentEntry
    if (entry.kind !== AGENT_KIND || !Number.isInteger(entry.seq) || entry.seq !== entries.length) {
      throw new WorkflowJournalError("parse", `workflow journal ${runId} is not dense at seq ${entries.length}`)
    }
    entries.push(entry)
    if (entries.length > MAX_JOURNAL_ENTRIES) {
      throw new WorkflowJournalError("full", `workflow journal ${runId} exceeds the ${MAX_JOURNAL_ENTRIES}-entry cap`)
    }
  }
  if (!header) throw new WorkflowJournalError("parse", `workflow journal ${runId} is empty`)
  return { header, entries, bytes: Buffer.byteLength(raw) }
}

export function createWorkflowJournal(runId: string, script: string, args: unknown, baseDir = stateDir(), workflowName?: string): void {
  mkdirSync(workflowJournalDir(runId, baseDir), { recursive: true })
  const header: JournalHeader = {
    v: 1,
    kind: HEADER_KIND,
    runId,
    scriptHash: fingerprint(script),
    argsHash: fingerprint(args ?? null),
    ...(workflowName ? { workflowName } : {}),
  }
  writeLine(workflowJournalPath(runId, baseDir), header)
}

function writeLine(path: string, record: JournalRecord): void {
  appendFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 })
}

export interface WorkflowJournal {
  runId: string
  replayOrReserve(prompt: string, opts: AgentOpts): { replayed: unknown } | { seq: number; reqHash: string }
  commit(seq: number, reqHash: string, result: unknown): void
}

export function openWorkflowJournal(opts: {
  runId: string
  script: string
  args?: unknown
  resume?: boolean
  baseDir?: string
  workflowName?: string
}): WorkflowJournal {
  const baseDir = opts.baseDir ?? stateDir()
  if (opts.resume) {
    const loaded = loadWorkflowJournal(opts.runId, baseDir)
    const scriptHash = fingerprint(opts.script)
    const argsHash = fingerprint(opts.args ?? null)
    if (loaded.header.scriptHash !== scriptHash) {
      throw new WorkflowJournalError(
        "header",
        `cannot resume workflow ${opts.runId}: script does not match the journaled run (script was edited or a different script was passed)`,
      )
    }
    if (loaded.header.argsHash !== argsHash) {
      throw new WorkflowJournalError(
        "header",
        `cannot resume workflow ${opts.runId}: args do not match the journaled run`,
      )
    }
    return new DiskJournal(opts.runId, loaded.entries, loaded.bytes, baseDir)
  }
  createWorkflowJournal(opts.runId, opts.script, opts.args, baseDir, opts.workflowName)
  return new DiskJournal(opts.runId, [], Buffer.byteLength(readFileSync(workflowJournalPath(opts.runId, baseDir))), baseDir)
}

class DiskJournal implements WorkflowJournal {
  private nextSeq = 0
  private readonly pending = new Map<number, JournalAgentEntry>()
  constructor(
    readonly runId: string,
    private readonly entries: JournalAgentEntry[],
    private bytes: number,
    private readonly baseDir: string,
  ) {}

  replayOrReserve(prompt: string, opts: AgentOpts): { replayed: unknown } | { seq: number; reqHash: string } {
    const seq = this.nextSeq++
    const reqHash = requestHash(prompt, opts)
    const recorded = this.entries[seq]
    if (!recorded) return { seq, reqHash }
    if (recorded.kind !== AGENT_KIND || recorded.reqHash !== reqHash) {
      throw new WorkflowJournalError(
        "divergence",
        `workflow journal divergence at seq ${seq}: the script issued a different agent() call than the recorded run — the script is nondeterministic or was edited mid-run`,
      )
    }
    return { replayed: recorded.result }
  }

  commit(seq: number, reqHash: string, result: unknown): void {
    if (seq < this.entries.length) return
    this.pending.set(seq, { seq, kind: AGENT_KIND, reqHash, result })
    this.flushDense()
  }

  private flushDense(): void {
    const path = workflowJournalPath(this.runId, this.baseDir)
    while (this.pending.has(this.entries.length)) {
      if (this.entries.length >= MAX_JOURNAL_ENTRIES) {
        throw new WorkflowJournalError("full", `workflow journal ${this.runId} hit the ${MAX_JOURNAL_ENTRIES}-entry cap`)
      }
      const entry = this.pending.get(this.entries.length)!
      this.pending.delete(entry.seq)
      const line = `${JSON.stringify(entry)}\n`
      const nextBytes = this.bytes + Buffer.byteLength(line)
      if (nextBytes > MAX_JOURNAL_BYTES) {
        throw new WorkflowJournalError("full", `workflow journal ${this.runId} hit the ${MAX_JOURNAL_BYTES}-byte cap`)
      }
      writeLine(path, entry)
      this.entries.push(entry)
      this.bytes = nextBytes
    }
  }
}

/** Wrap `inner` with a journal when the session is not incognito. Resume reuses
 *  `resumeFrom` as the run id; a fresh run journals under `inner.runId`. */
export function prepareJournaledHost(
  inner: WorkflowHost,
  opts: { script: string; args?: unknown; resumeFrom?: string; incognito?: boolean; baseDir?: string; workflowName?: string },
): { host: WorkflowHost; journaled: boolean; runId: string } {
  if (opts.incognito) {
    if (opts.resumeFrom) {
      throw new WorkflowJournalError("missing", "cannot resume a workflow in an incognito session — journals are not written there")
    }
    return { host: inner, journaled: false, runId: inner.runId }
  }
  const runId = opts.resumeFrom ?? inner.runId
  const journal = openWorkflowJournal({
    runId,
    script: opts.script,
    args: opts.args,
    resume: !!opts.resumeFrom,
    baseDir: opts.baseDir,
    workflowName: opts.workflowName,
  })
  const host = journalingHost({ ...inner, runId }, journal)
  return { host, journaled: true, runId }
}

/** Append a same-process resume hint to a failed workflow result. Successful
 *  results are left unchanged so the sync tool path stays byte-identical. */
export function annotateWorkflowResult(runId: string, result: string, journaled: boolean): string {
  if (!journaled || !result.startsWith("workflow error:")) return result
  if (result.includes("resume_from_run_id")) return result
  return `${result} Run id: ${runId}. Re-invoke workflow with resume_from_run_id to retry from the journal (same-process only; an uncommitted in-flight agent may re-run).`
}

/**
 * Wrap `inner` so agent() results are journaled / replayed. phase/log/emit and
 * routing still go through the inner host unchanged. `onAgent` is the only
 * result-bearing hook — the engine calls it instead of composing spawn+schema
 * itself when present.
 */
export function journalingHost(inner: WorkflowHost, journal: WorkflowJournal): WorkflowHost {
  return {
    ...inner,
    async journalAgent(prompt: string, opts: AgentOpts, live: () => Promise<unknown>): Promise<unknown> {
      const reserved = journal.replayOrReserve(prompt, opts)
      if ("replayed" in reserved) return reserved.replayed
      const result = await live()
      journal.commit(reserved.seq, reserved.reqHash, result)
      return result
    },
  }
}
