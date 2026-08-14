// Eval replay: re-run a recorded candidate against a model in a throwaway
// worktree. Never touches the user's repo, the shadow refs, or the candidate.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { spawnSync } from "node:child_process"
import { AsyncLocalStorageProviderSingleton } from "@langchain/core/singletons"
import type {
  EvalCandidateJson,
  EvalReplayResultJson,
  EvalReplayStartResponse,
  EvalReplaySummary,
} from "@chunky/protocol"
import type { AgentEvent } from "@chunky/protocol"
import {
  EvalRecorderError,
  evalsRoot,
  getEvalCandidateDetail,
} from "./eval-recorder.ts"
import { restoreSnapshot } from "./shadow-git.ts"
import { getSidekickAgent, RECURSION_LIMIT } from "./agent.ts"
import { providerRuntime, type AgentSelection } from "./providers/registry.ts"
import { isEffort } from "./settings.ts"
import { sidekickSystemPrompt } from "./prompt.ts"
import { distilledAgentsMd } from "./agents-md.ts"
import { streamWithCheckpointRecovery } from "./checkpoint-recovery.ts"
import { translateStream } from "./run.ts"

const REPLAY_TIMEOUT_MS = 30 * 60_000
const running = new Set<string>()

export type EvalReplayWorker = (opts: {
  workspace: string
  brief: string
  selection: AgentSelection
  abort: AbortController
}) => Promise<string>

let injectedWorker: EvalReplayWorker | undefined

export function setEvalReplayWorkerForTests(worker: EvalReplayWorker | undefined): void {
  injectedWorker = worker
}

export function evalReplayRoot(delegationId: string): string {
  return join(evalsRoot(), "replays", delegationId)
}

export function evalReplayDir(delegationId: string, replayId: string): string {
  return join(evalReplayRoot(delegationId), replayId)
}

function readJsonIfPresent<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined
  try { return JSON.parse(readFileSync(path, "utf8")) as T } catch { return undefined }
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2), { mode: 0o600 })
}

function gitIn(workspace: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync("git", args, { cwd: workspace, encoding: "utf8" })
  return { ok: result.status === 0, stdout: (result.stdout ?? "").trim(), stderr: result.stderr ?? "" }
}

export function restoreEvalReplayWorkspace(candidate: EvalCandidateJson, dest: string): void {
  mkdirSync(dest, { recursive: true })
  const commit = candidate.snapshot || candidate.snapshotRef
  if (!commit) throw new EvalRecorderError(404, "candidate has no snapshot")
  const ok = restoreSnapshot(candidate.workspace, commit, dest)
  if (!ok) throw new EvalRecorderError(409, "failed to restore snapshot into replay workspace")
}

export function writeReplayBaseline(workspace: string): void {
  if (!gitIn(workspace, ["init"]).ok) throw new Error("git init failed in replay workspace")
  gitIn(workspace, ["add", "-A"])
  const committed = gitIn(workspace, [
    "-c", "user.name=Chunky",
    "-c", "user.email=chunky@local",
    "-c", "commit.gpgsign=false",
    "commit", "--allow-empty", "-m", "eval replay baseline",
  ])
  if (!committed.ok) throw new Error(`git commit baseline failed: ${committed.stderr}`)
}

export function captureReplayDiff(workspace: string): string {
  gitIn(workspace, ["add", "-A"])
  const diff = gitIn(workspace, ["diff", "--cached"])
  return diff.ok ? diff.stdout : ""
}

function resolveSelection(candidate: EvalCandidateJson, override?: { provider?: string; model?: string; effort?: string }): AgentSelection {
  const provider = override?.provider?.trim() || candidate.provider
  const model = override?.model?.trim() || candidate.model
  const effortRaw = override?.effort?.trim() || candidate.effort
  const effort = isEffort(effortRaw) ? effortRaw : undefined
  return { provider, model, ...(effort ? { effort } : {}) }
}

function sink(_event: AgentEvent): void {
  // Replay must not emit into any real session.
}

async function defaultWorker(opts: {
  workspace: string
  brief: string
  selection: AgentSelection
  abort: AbortController
}): Promise<string> {
  const agentsMd = await distilledAgentsMd(opts.workspace, opts.selection)
  const threadId = `eval-replay:${randomUUID()}`
  if (providerRuntime(opts.selection.provider) === "anthropic-sdk") {
    const { runAnthropicAgent } = await import("./anthropic-runner.ts")
    return await runAnthropicAgent({
      selection: opts.selection,
      threadId,
      prompt: opts.brief,
      emit: sink,
      eventThreadId: threadId,
      systemPrompt: sidekickSystemPrompt(agentsMd, "standard"),
      allowedTools: [
        "mcp__chunky__read",
        "mcp__chunky__bash",
        "mcp__chunky__fffind",
        "mcp__chunky__ffgrep",
        "mcp__chunky__write",
        "mcp__chunky__edit",
      ],
      workspace: opts.workspace,
      agentsMd,
      abort: opts.abort,
    })
  }
  const stream = await AsyncLocalStorageProviderSingleton.getInstance().run(undefined, () =>
    streamWithCheckpointRecovery(
      getSidekickAgent(opts.selection, opts.workspace, agentsMd),
      { messages: [{ role: "user", content: opts.brief }] },
      {
        configurable: { thread_id: threadId, workspace: opts.workspace },
        streamMode: ["updates", "messages"],
        recursionLimit: RECURSION_LIMIT,
        signal: opts.abort.signal,
      } as never,
    ),
  )
  return await translateStream(stream, threadId, sink)
}

function listReplayIds(delegationId: string): string[] {
  const root = evalReplayRoot(delegationId)
  try {
    return readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return []
  }
}

export function listEvalReplays(delegationId: string): EvalReplaySummary[] {
  const rows: EvalReplaySummary[] = []
  for (const replayId of listReplayIds(delegationId)) {
    const dir = evalReplayDir(delegationId, replayId)
    const result = readJsonIfPresent<EvalReplayResultJson>(join(dir, "result.json"))
    const started = readJsonIfPresent<{
      replayId: string
      provider: string
      model: string
      effort?: string
      startedAt: number
      status?: string
    }>(join(dir, "started.json"))
    if (result) {
      rows.push({
        replayId: result.replayId,
        provider: result.provider,
        model: result.model,
        ...(result.effort ? { effort: result.effort } : {}),
        status: result.ok ? "done" : "error",
        ok: result.ok,
        startedAt: result.startedAt,
        completedAt: result.completedAt,
      })
      continue
    }
    if (!started) continue
    rows.push({
      replayId: started.replayId,
      provider: started.provider,
      model: started.model,
      ...(started.effort ? { effort: started.effort } : {}),
      status: "running",
      startedAt: started.startedAt,
    })
  }
  rows.sort((a, b) => b.startedAt - a.startedAt || b.replayId.localeCompare(a.replayId))
  return rows
}

async function finishReplay(opts: {
  delegationId: string
  replayId: string
  workspace: string
  selection: AgentSelection
  brief: string
  startedAt: number
}): Promise<void> {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(new Error("eval replay timed out after 30 minutes")), REPLAY_TIMEOUT_MS)
  ;(timer as { unref?: () => void }).unref?.()
  let finalReport = ""
  let ok = false
  try {
    const worker = injectedWorker ?? defaultWorker
    finalReport = await worker({
      workspace: opts.workspace,
      brief: opts.brief,
      selection: opts.selection,
      abort,
    })
    ok = !finalReport.startsWith("error:") && !abort.signal.aborted
  } catch (err) {
    const message = abort.signal.aborted
      ? (abort.signal.reason instanceof Error ? abort.signal.reason.message : "eval replay timed out after 30 minutes")
      : ((err as Error)?.message ?? String(err))
    finalReport = `error: ${message}`
    ok = false
  } finally {
    clearTimeout(timer)
  }
  const result: EvalReplayResultJson = {
    replayId: opts.replayId,
    provider: opts.selection.provider,
    model: opts.selection.model ?? "unknown",
    ...(opts.selection.effort ? { effort: opts.selection.effort } : {}),
    ok,
    finalReport,
    startedAt: opts.startedAt,
    completedAt: Date.now(),
    diff: captureReplayDiff(opts.workspace),
  }
  writeJson(join(evalReplayDir(opts.delegationId, opts.replayId), "result.json"), result)
}

export function startEvalReplay(
  delegationId: string,
  override?: { provider?: string; model?: string; effort?: string },
): EvalReplayStartResponse {
  const detail = getEvalCandidateDetail(delegationId)
  const candidate = detail.candidate
  if (running.has(candidate.delegationId)) throw new EvalRecorderError(409, "replay already running")
  running.add(candidate.delegationId)
  const replayId = randomUUID()
  const dir = evalReplayDir(candidate.delegationId, replayId)
  const workspace = join(dir, "workspace")
  mkdirSync(dir, { recursive: true })
  try {
    restoreEvalReplayWorkspace(candidate, workspace)
    writeReplayBaseline(workspace)
  } catch (err) {
    running.delete(candidate.delegationId)
    throw err
  }
  const selection = resolveSelection(candidate, override)
  const startedAt = Date.now()
  writeJson(join(dir, "started.json"), {
    replayId,
    provider: selection.provider,
    model: selection.model ?? "unknown",
    ...(selection.effort ? { effort: selection.effort } : {}),
    startedAt,
    status: "running",
  })
  void finishReplay({
    delegationId: candidate.delegationId,
    replayId,
    workspace,
    selection,
    brief: candidate.briefComposed,
    startedAt,
  }).catch((err) => {
    const result: EvalReplayResultJson = {
      replayId,
      provider: selection.provider,
      model: selection.model ?? "unknown",
      ...(selection.effort ? { effort: selection.effort } : {}),
      ok: false,
      finalReport: `error: ${(err as Error)?.message ?? String(err)}`,
      startedAt,
      completedAt: Date.now(),
      diff: existsSync(workspace) ? captureReplayDiff(workspace) : "",
    }
    try { writeJson(join(dir, "result.json"), result) } catch { /* persist best-effort */ }
  }).finally(() => {
    running.delete(candidate.delegationId)
  })
  return { replayId, status: "running" }
}

export function isEvalReplayRunning(delegationId: string): boolean {
  return running.has(delegationId)
}

export function resetEvalReplayStateForTests(): void {
  running.clear()
  injectedWorker = undefined
}
