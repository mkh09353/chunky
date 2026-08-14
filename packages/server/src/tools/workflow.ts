// workflow — run a dynamic-workflow: a JavaScript orchestration script that fans
// out many sub-agents in parallel and returns one synthesized result. It resolves
// the active run's ThreadManager the same way spawn_thread/advisor do (via
// configurable.thread_id) and delegates to ctx.runWorkflow, so every agent() in
// the script is a real, isolated child thread streamed over the session SSE.
import { tool } from "@langchain/core/tools"
import { z } from "zod"
import { threadContextFor } from "../thread-context.ts"
import { workspaceFromConfig } from "../workspace.ts"
import {
  formatAvailableWorkflows,
  resolveSavedWorkflow,
  scanSavedWorkflows,
  type ScanOptions,
} from "../workflow/registry.ts"

const DESCRIPTION = `Run a dynamic workflow: a JavaScript orchestration script that fans out many sub-agents in parallel, then returns ONE synthesized result. Reserve it for work that genuinely needs MANY parallel sub-agents — codebase-wide audits, reviewing every file in a dir, cross-checked research, big multi-phase refactors — or for when the user explicitly asks for a workflow. Do NOT use it for anything a direct answer or one sidekick/spawn_thread brief covers: ordinary features and fixes, short tasks, serial debugging (where accumulated context is the work), or questions. If you don't have a concrete work-list to fan out over (files, findings, items), scout first or delegate instead. Intermediate results stay in script variables — only the final return value enters your context, keeping it lean.

Pass exactly one of script (inline JS) or name (a saved workflow). Saved workflows live in the project at .chunky/workflows/<name>.workflow.js (wins on collision) and in the user library at ~/.chunky/workflows/<name>.workflow.js. Each file is our JS dialect; optional metadata is \`export const meta = { name, description, when_to_use }\` or a leading comment with the same fields (name is kebab-case). Missing meta falls back to the filename. You may write reusable scripts there with the write tool. To discover saved names, omit both script and name (or pass an unknown name) — the error lists what is installed. Project files win over user files of the same name.

By default this tool is synchronous: it waits for the script's final \`return\` and that value is the tool result. Set detach=true for a long-running fan-out so the tool returns immediately with a run id; the script continues server-side and its completion (or \`workflow error: …\`) arrives later as a wake/reminder. Explicit detach=true skips the STEER-detach race — the call is fire-and-forget from the first moment. Omitting detach (or false) keeps today's awaited path, including STEER-detach if the user steers mid-run. Use detach for long-running fan-outs; default stays sync.

Failed runs leave a same-process journal of committed agent() results. Re-invoke the SAME script+args (or the same saved name+args) with resume_from_run_id to replay those calls without re-spawning children, then continue from the first uncommitted call. Resume is not exactly-once (an in-flight agent that never committed may re-run) and does not survive a server restart. Editing a saved file between run and resume is a divergence. Incognito sessions skip journaling.

The script is JavaScript with top-level \`await\`; \`return\` the final value. Available globals:
- agent(prompt, opts?) -> the sub-agent's final text; if opts.schema (a JSON Schema) is set, returns the parsed object (or null on failure). opts: { label, phase, tags: string[], tier:'small'|'medium'|'big', provider, model, effort, speed }.
- parallel(thunks) -> run an array of () => agent(...) concurrently; returns results in order (a failed one is null).
- pipeline(items, ...stages) -> run each item through the stages independently (no barrier); stage signature (prev, item, index).
- phase(title) / log(msg) -> progress grouping + a narrator line the user sees.
- args -> the args you passed to this tool. budget -> { total, spent(), remaining() } (stub for now).
Concurrency is capped automatically. Date.now()/Math.random() are disabled (runs must be deterministic) — vary work by array index. Prefer semantic tags over raw model ids: general, fast, research, frontend, design, premium. Chunky resolves tags to provider-qualified routes, preferring subscription and known-free targets; unmatched specialties stop so you can ask the user. Explicit provider/model is for a user-requested override.

Example:
const files = (await agent('List the route files under src/routes, one path per line, no prose.', { tags: ['fast', 'general'] })).split('\\n').filter(Boolean)
phase('Review')
const found = await parallel(files.map(f => () => agent(\`Audit \${f} for missing auth checks. Be specific.\`, { tags: ['general'] })))
phase('Synthesize')
return await agent('Synthesize these audit findings into the top risks:\\n' + found.filter(Boolean).join('\\n\\n'), { tags: ['premium'] })`

export const workflowInputShape = {
  script: z
    .string()
    .optional()
    .describe("Inline JavaScript orchestration script (top-level await; `return` the final value). Exactly one of script or name."),
  name: z
    .string()
    .optional()
    .describe(
      "Saved workflow name (kebab-case). Loads .chunky/workflows/<name>.workflow.js from the project (wins) or ~/.chunky/workflows/. Exactly one of script or name.",
    ),
  args: z
    .any()
    .optional()
    .describe("Optional JSON value exposed to the script as the global `args`."),
  detach: z
    .boolean()
    .optional()
    .describe(
      "Run the script in the background and return immediately with a run id; the final result arrives later as a wake/reminder. " +
        "Use for long-running fan-outs. Omit or false to wait synchronously for the final return. Explicit true skips STEER-detach.",
    ),
  resume_from_run_id: z
    .string()
    .optional()
    .describe(
      "Resume a previous same-process workflow run from its journal. Must pass the identical script/name and args; " +
        "committed agent() results replay without spawning, then live execution continues. Not exactly-once and not cross-restart.",
    ),
}

export interface WorkflowToolInput {
  script?: string
  name?: string
  args?: unknown
  detach?: boolean
  resume_from_run_id?: string
}

export function resolveWorkflowSource(
  input: Pick<WorkflowToolInput, "script" | "name">,
  scan: ScanOptions = {},
): { script: string; workflowName?: string } | { error: string } {
  const hasScript = typeof input.script === "string" && input.script.length > 0
  const hasName = typeof input.name === "string" && input.name.trim().length > 0
  const available = () => formatAvailableWorkflows(scanSavedWorkflows(scan))
  if (hasScript === hasName) {
    return {
      error: hasScript
        ? "error: pass exactly one of script or name — not both."
        : `error: pass exactly one of script or name. Saved workflows: ${available()}`,
    }
  }
  if (hasScript) return { script: input.script! }
  const name = input.name!.trim()
  const saved = resolveSavedWorkflow(name, scan)
  if (!saved) return { error: `error: unknown workflow "${name}". Saved workflows: ${available()}` }
  return { script: saved.script, workflowName: saved.name }
}

export const workflow = tool(
  async (input: WorkflowToolInput, config?: unknown) => {
    const callerThreadId = (config as any)?.configurable?.thread_id as string | undefined
    const ctx = threadContextFor(callerThreadId)
    if (!ctx || !callerThreadId) {
      return "error: workflow is only available inside an active session run."
    }
    const resolved = resolveWorkflowSource(input, { workspace: workspaceFromConfig(config) })
    if ("error" in resolved) return resolved.error
    const startWork = () =>
      ctx.runWorkflow({
        callerThreadId,
        script: resolved.script,
        args: input.args,
        resumeFromRunId: input.resume_from_run_id,
        workflowName: resolved.workflowName,
      })
    // Explicit detach=true short-circuits to detachDelegate (no STEER race).
    // Omitted/false keeps the awaited path, including STEER-detach mid-run.
    return ctx.runSteerDetachable?.("workflow", "Workflow", startWork, { detach: input.detach }) ?? startWork()
  },
  {
    name: "workflow",
    description: DESCRIPTION,
    schema: z.object(workflowInputShape),
  },
)
