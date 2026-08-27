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

const DESCRIPTION = `Run a dynamic workflow only for work needing MANY parallel sub-agents (broad audits/research or large fan-outs), or when explicitly requested. Script API (JavaScript with top-level await):
- agent(prompt: string, opts?) calls one sub-agent. The prompt MUST be nonblank. Object form { prompt | instructions | task, ...opts } is also accepted. opts: { label, phase, tags: string[], tier:'small'|'medium'|'big', provider, model, effort, speed, schema }.
- parallel(thunks) runs an array of () => agent(...) concurrently and returns ordered results; failures are null.
- phase(title) groups visible progress; log(msg) narrates progress. pipeline(items, ...stages) is also available.
- args is the JSON value passed to this tool. Use return to produce the ONE final workflow result.
Minimal example (3 lines):
const files = (await agent('List files, one per line.')).split('\\n').filter(Boolean)
const reviews = await parallel(files.map(f => () => agent('Audit ' + f, { tags: ['general'] })))
phase('Synthesize'); return await agent('Summarize:\\n' + reviews.filter(Boolean).join('\\n'))

Pass exactly one of script (inline JS) or name (saved workflow); omit both to list saved workflows and full docs. Optional args becomes the script global args. Default execution waits for return; detach=true runs a long fan-out in the background. resume_from_run_id resumes an eligible failed run.

Do NOT use workflow for ordinary features/fixes, short tasks, questions, serial debugging, or anything a direct answer or one sidekick/spawn_thread brief covers. Without a concrete list of independent items, scout or delegate instead. Only return enters your context. Runs are concurrency-capped and deterministic (no Date.now/Math.random). Prefer semantic tags (general, fast, research, frontend, design, premium); use provider/model only for a requested override.`

const WORKFLOW_DOCS = `Full workflow docs: saved files are .chunky/workflows/<name>.workflow.js in the project (wins collisions) or ~/.chunky/workflows/<name>.workflow.js. Optional metadata is an exported meta object or leading metadata comment with name, description, and when_to_use; name is kebab-case and missing metadata falls back to the filename. Default execution waits for return. detach=true is fire-and-forget immediately (skipping the STEER-detach race); completion or workflow error arrives as a wake/reminder. Without explicit detach, steering may detach an awaited run. Failed non-incognito runs keep a same-process journal: resume_from_run_id requires identical script/name and args, replays committed agent() results, may rerun an uncommitted call, does not survive restart, and diverges if a saved file changed.`
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
        : `error: pass exactly one of script or name. Saved workflows: ${available()}\n\n${WORKFLOW_DOCS}`,
    }
  }
  if (hasScript) return { script: input.script! }
  const name = input.name!.trim()
  const saved = resolveSavedWorkflow(name, scan)
  if (!saved) return { error: `error: unknown workflow "${name}". Saved workflows: ${available()}\n\n${WORKFLOW_DOCS}` }
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
