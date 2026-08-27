// get_delegate_status — read-only snapshots of detached and live delegate work.
import { tool } from "@langchain/core/tools"
import { z } from "zod"
import { getDetachedSpawn, listDetachedSpawns, type DetachedSpawnRecord, type DetachedSpawnStatus } from "../detached-spawns.ts"
import { threadContextFor } from "../thread-context.ts"
import { toolResult } from "./result.ts"

export const getDelegateStatusInputShape = {
  run_id: z.string().optional().describe("Detached run id returned by a detach=true delegate launch."),
  seat: z.string().optional().describe("Sidekick seat to inspect; omit for all delegates in this session."),
  timeout_ms: z.number().nonnegative().optional().describe("0/omitted is nonblocking; otherwise wait for the target(s) to settle, capped at 600000ms."),
}

export interface GetDelegateStatusInput {
  run_id?: string
  seat?: string
  timeout_ms?: number
}

export interface DelegateStatusRecord {
  kind: "sidekick" | "spawn_thread" | "workflow"
  run_id?: string
  thread_id: string
  seat?: string
  title: string
  status: DetachedSpawnStatus
  elapsed_ms: number
  tool_call_count?: number
  live_tail?: string[]
  result?: string
}

export interface DelegateStatusResponse {
  runs: DelegateStatusRecord[]
}

const RESULT_CHARS = 2_000

function resultPreview(text: string | undefined): string | undefined {
  if (text === undefined) return undefined
  return text.length <= RESULT_CHARS ? text : `${text.slice(0, RESULT_CHARS)}\n[truncated]`
}

function detachedView(record: DetachedSpawnRecord, now: number): DelegateStatusRecord {
  return {
    kind: record.kind ?? "spawn_thread",
    run_id: record.id,
    thread_id: record.childThreadId,
    ...(record.seat ? { seat: record.seat } : {}),
    title: record.title,
    status: record.status,
    elapsed_ms: Math.max(0, (record.endedAt ?? now) - record.startedAt),
    ...(record.status !== "running" && record.result !== undefined ? { result: resultPreview(record.result) } : {}),
  }
}

async function liveStatuses(sessionId: string) {
  // Dynamic import avoids agent.ts -> tool -> threads.ts -> agent.ts.
  const { listLiveDelegateStatuses } = await import("../threads.ts")
  return listLiveDelegateStatuses(sessionId)
}

async function selected(sessionId: string, input: GetDelegateStatusInput) {
  const runId = input.run_id?.trim()
  const seat = input.seat?.trim()
  if (runId) {
    const record = getDetachedSpawn(sessionId, runId)
    return record ? { detached: [record], live: [] } : { detached: [], live: [], unknownRunId: runId }
  }
  const detached = listDetachedSpawns(sessionId).filter((record) => !seat || (record.seat ?? "default") === seat)
  const live = (await liveStatuses(sessionId)).filter((record) => !seat || (record.seat ?? "default") === seat)
  return { detached, live }
}

async function waitForSelected(sessionId: string, input: GetDelegateStatusInput): Promise<void> {
  const timeout = Math.min(600_000, Math.max(0, input.timeout_ms ?? 0))
  if (!timeout) return
  const target = await selected(sessionId, input)
  if ("unknownRunId" in target || (!target.detached.length && !target.live.length)) return
  const waits = [
    ...target.detached.filter((record) => record.status === "running").map((record) => record.done),
    ...target.live.map((record) => record.done),
  ]
  if (!waits.length) return
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    Promise.all(waits),
    new Promise<void>((resolve) => { timer = setTimeout(resolve, timeout) }),
  ]).finally(() => { if (timer) clearTimeout(timer) })
}

export async function getDelegateStatuses(sessionId: string, input: GetDelegateStatusInput = {}): Promise<DelegateStatusResponse | { error: string }> {
  await waitForSelected(sessionId, input)
  const target = await selected(sessionId, input)
  if ("unknownRunId" in target) {
    return { error: `no delegate run with that id in this session (${target.unknownRunId}); bash background tasks use get_task_output.` }
  }
  const now = Date.now()
  const detachedThreadIds = new Set(target.detached.map((record) => record.childThreadId))
  const detachedSeats = new Set(target.detached.filter((record) => record.kind === "sidekick").map((record) => record.seat ?? "default"))
  const runs = target.detached.map((record) => detachedView(record, now))
  for (const live of target.live) {
    // A detached record and its live worker are one run, not two list entries.
    if (detachedThreadIds.has(live.threadId) || (live.kind === "sidekick" && detachedSeats.has(live.seat ?? "default"))) continue
    runs.push({
      kind: live.kind,
      thread_id: live.threadId,
      ...(live.seat ? { seat: live.seat } : {}),
      title: live.title,
      status: "running",
      elapsed_ms: Math.max(0, now - live.startedAt),
    })
  }
  return { runs }
}

export const getDelegateStatusTool = tool(
  async (input: GetDelegateStatusInput, config?: unknown) => {
    const callerThreadId = (config as any)?.configurable?.thread_id as string | undefined
    const ctx = threadContextFor(callerThreadId)
    if (!ctx) return "error: get_delegate_status is only available inside an active session run."
    const response = await getDelegateStatuses(ctx.sessionId, input)
    if ("error" in response) return toolResult(response.error, { ok: false, raw: response })
    const text = response.runs.length
      ? response.runs.map((run) => `${run.run_id ?? run.thread_id}: ${run.status} — ${run.title}${run.result ? `\n${run.result}` : ""}`).join("\n")
      : "No delegate runs in this session."
    return toolResult(text, { raw: { kind: "delegate-status", ...response } })
  },
  {
    name: "get_delegate_status",
    description: "List or poll detached workflow, spawn_thread, and sidekick runs in this session. Pass run_id or seat to target one worker; timeout_ms optionally waits for settlement. Use get_task_output only for background bash tasks. Read-only.",
    schema: z.object(getDelegateStatusInputShape),
  },
)
