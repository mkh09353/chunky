// The workflow engine: the primitives a script orchestrates with (agent /
// parallel / pipeline / phase / log / budget) and the entry point that runs a
// script against a WorkflowHost. The host is injected (not reached through
// globals) so this file is pure and unit-testable — the deterministic test wires
// a fake host, while ThreadManager.runWorkflow wires the real spawn machinery.
//
// The whole point: `agent(prompt, opts)` is `spawn_thread`, but driven by
// deterministic JS instead of by the model calling it one at a time. Every agent
// is a real, isolated child thread that streams over the session SSE (so they
// render live in the TUI thread-tree), and intermediate results live in script
// variables — only the final `return` value comes back into the model's context.
import os from "node:os"
import type { AgentEvent } from "@chunky/protocol"
import type { AgentSelectionOverride, Effort, Speed } from "../providers/registry.ts"
import { runScript } from "./runtime.ts"

/** The minimal surface the engine needs from the run it executes inside. */
export interface WorkflowHost {
  /** Unique id for this workflow run (minted outside the sandbox). */
  runId: string
  /** The thread that owns this run — used to tag workflow.* events so they render
   *  in the owner's transcript. undefined = the root/main thread (events untagged). */
  ownerThreadId?: string
  /** Max concurrent agent() calls. */
  concurrency: number
  /** Emit a protocol event onto the session SSE. */
  emit: (ev: AgentEvent) => void
  /** Launch one sub-agent (a real child thread) and return its final text. */
  spawn: (opts: { title: string; instructions: string; selection?: AgentSelectionOverride }) => Promise<string>
  /** Resolve a small/medium/big tier to a model override (undefined = inherit).
   *  Optional so a test host can omit it (tier then inherits). */
  tierOverride?: (tier: WorkflowTier) => AgentSelectionOverride | undefined
}

export type WorkflowTier = "small" | "medium" | "big"

/** Options for one agent() call. Mirrors spawn_thread's selection knobs plus
 *  workflow-only display/routing/structured-output fields. */
export interface AgentOpts {
  label?: string
  phase?: string
  tier?: WorkflowTier
  provider?: string
  model?: string
  effort?: Effort
  speed?: Speed
  /** JSON Schema — when present, agent() returns the parsed object (or null). */
  schema?: unknown
}

/** Backstop total-agent cap per run (a runaway-loop guard, far above real use). */
const MAX_AGENTS_PER_RUN = 1000

/** Default concurrency: min(16, cpus - 2), never below 1. */
export function workflowConcurrency(): number {
  const cpus = os.cpus?.().length ?? 4
  return Math.max(1, Math.min(16, cpus - 2))
}

/**
 * Classic transfer-slot semaphore: `active` is incremented only when a free slot
 * is taken; on release a waiting acquirer inherits the slot (count unchanged), so
 * `active` never exceeds `max`.
 */
class Semaphore {
  private active = 0
  private readonly waiters: Array<() => void> = []
  constructor(private readonly max: number) {}
  private acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => this.waiters.push(resolve))
  }
  private release(): void {
    const next = this.waiters.shift()
    if (next) next()
    else this.active--
  }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire()
    try {
      return await fn()
    } finally {
      this.release()
    }
  }
}

/** Best-effort extraction of a JSON value from a model reply: strips ``` fences,
 *  then parses the first balanced object/array. Returns undefined on failure. */
function extractJson(text: string): unknown {
  const unfenced = text.replace(/```(?:json)?\s*([\s\S]*?)```/gi, "$1").trim()
  const candidates = [unfenced]
  const firstBrace = unfenced.search(/[[{]/)
  if (firstBrace > 0) candidates.push(unfenced.slice(firstBrace))
  for (const c of candidates) {
    try {
      return JSON.parse(c)
    } catch {
      /* try next */
    }
  }
  // Fall back to the outermost {...} or [...] span.
  const objSpan = sliceBalanced(unfenced, "{", "}")
  if (objSpan) {
    try {
      return JSON.parse(objSpan)
    } catch {
      /* ignore */
    }
  }
  const arrSpan = sliceBalanced(unfenced, "[", "]")
  if (arrSpan) {
    try {
      return JSON.parse(arrSpan)
    } catch {
      /* ignore */
    }
  }
  return undefined
}

function sliceBalanced(s: string, open: string, close: string): string | undefined {
  const start = s.indexOf(open)
  const end = s.lastIndexOf(close)
  return start >= 0 && end > start ? s.slice(start, end + 1) : undefined
}

function schemaSuffix(schema: unknown): string {
  return (
    "\n\nReturn ONLY a JSON value matching this JSON Schema — no prose, no explanation, no markdown code fences:\n" +
    JSON.stringify(schema)
  )
}

/** Derive a short agent label from its prompt when the script gives none. */
function deriveLabel(prompt: string): string {
  const firstLine = prompt.trim().split("\n", 1)[0] ?? "agent"
  return firstLine.length > 60 ? firstLine.slice(0, 57) + "…" : firstLine
}

/**
 * Build the sandbox scope (the globals a script sees) for one run against `host`.
 * `phaseState` is closed over so phase() set here is read by later agent() calls.
 */
function buildScope(host: WorkflowHost, args: unknown): Record<string, unknown> {
  const sem = new Semaphore(host.concurrency)
  let currentPhase: string | undefined
  let totalAgents = 0

  const selectionFor = (opts: AgentOpts): AgentSelectionOverride | undefined => {
    const explicit: AgentSelectionOverride = {}
    if (opts.provider) explicit.provider = opts.provider
    if (opts.model) explicit.model = opts.model
    if (opts.effort) explicit.effort = opts.effort
    if (opts.speed) explicit.speed = opts.speed
    if (Object.keys(explicit).length > 0) return explicit
    if (opts.tier && host.tierOverride) return host.tierOverride(opts.tier)
    return undefined
  }

  async function agent(prompt: unknown, opts: AgentOpts = {}): Promise<unknown> {
    if (typeof prompt !== "string" || !prompt.trim()) {
      throw new Error("agent(prompt, opts?) — `prompt` must be a non-empty string.")
    }
    if (++totalAgents > MAX_AGENTS_PER_RUN) {
      throw new Error(`workflow exceeded the ${MAX_AGENTS_PER_RUN}-agent per-run cap (likely a runaway loop).`)
    }
    const selection = selectionFor(opts)
    const label = opts.label ?? deriveLabel(prompt)
    const phase = opts.phase ?? currentPhase
    const title = phase ? `${phase} · ${label}` : label

    return sem.run(async () => {
      const instructions = opts.schema ? prompt + schemaSuffix(opts.schema) : prompt
      const text = await host.spawn({ title, instructions, selection })
      if (!opts.schema) return text
      const parsed = extractJson(text)
      if (parsed !== undefined) return parsed
      // One corrective retry, then give up (null → the script can .filter(Boolean)).
      const retry = await host.spawn({
        title: `${title} (retry)`,
        instructions:
          instructions +
          "\n\nYour previous reply was NOT valid JSON. Return ONLY the JSON value, nothing else — no prose, no code fences.",
        selection,
      })
      const reparsed = extractJson(retry)
      return reparsed === undefined ? null : reparsed
    })
  }

  // parallel/pipeline deliberately do NOT take a semaphore slot themselves — only
  // agent() does — so a thunk that calls agent() can't deadlock against its own
  // outer slot. Many thunks may be "in flight"; only `concurrency` agents run.
  async function parallel(thunks: unknown): Promise<unknown[]> {
    if (!Array.isArray(thunks)) throw new Error("parallel(thunks) — pass an array of () => Promise functions.")
    return Promise.all(
      thunks.map(async (t) => {
        if (typeof t !== "function") throw new Error("parallel(thunks) — each item must be a function: () => agent(...).")
        try {
          return await t()
        } catch {
          return null
        }
      }),
    )
  }

  async function pipeline(items: unknown, ...stages: unknown[]): Promise<unknown[]> {
    if (!Array.isArray(items)) throw new Error("pipeline(items, ...stages) — `items` must be an array.")
    const fns = stages.filter((s): s is (...a: unknown[]) => unknown => typeof s === "function")
    return Promise.all(
      items.map(async (item, index) => {
        let value: unknown = item
        for (const stage of fns) {
          try {
            value = await stage(value, item, index)
          } catch {
            return null
          }
        }
        return value
      }),
    )
  }

  function phase(title: unknown): void {
    currentPhase = typeof title === "string" ? title : String(title)
    host.emit({ type: "workflow.phase", runId: host.runId, threadId: host.ownerThreadId, title: currentPhase })
  }

  function log(message: unknown): void {
    const text = typeof message === "string" ? message : String(message)
    host.emit({ type: "workflow.log", runId: host.runId, threadId: host.ownerThreadId, message: text })
  }

  // Budget is a no-op stub in the lean v1 (token budgeting is a later increment),
  // but present so a script that references it doesn't crash.
  const budget = { total: null as number | null, spent: () => 0, remaining: () => Infinity }

  return { agent, parallel, pipeline, phase, log, budget, args }
}

/**
 * Run one workflow `script` against `host` and return its final value coerced to
 * a string for the model. This is the engine entry point ThreadManager calls.
 */
export async function runWorkflowScript(host: WorkflowHost, script: string, args?: unknown): Promise<string> {
  host.emit({ type: "workflow.log", runId: host.runId, threadId: host.ownerThreadId, message: "⚡ workflow started" })
  const scope = buildScope(host, args)
  let result: unknown
  try {
    result = await runScript(script, scope)
  } catch (err) {
    const message = (err as Error)?.message ?? String(err)
    host.emit({ type: "workflow.log", runId: host.runId, threadId: host.ownerThreadId, message: `⚠ workflow error: ${message}` })
    return `workflow error: ${message}`
  }
  host.emit({ type: "workflow.log", runId: host.runId, threadId: host.ownerThreadId, message: "✓ workflow finished" })
  return stringifyResult(result)
}

function stringifyResult(result: unknown): string {
  if (result == null) return "workflow finished (no value returned)."
  if (typeof result === "string") return result
  try {
    return JSON.stringify(result, null, 2)
  } catch {
    return String(result)
  }
}
