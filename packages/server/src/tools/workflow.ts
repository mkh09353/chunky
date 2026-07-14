// workflow — run a dynamic-workflow: a JavaScript orchestration script that fans
// out many sub-agents in parallel and returns one synthesized result. It resolves
// the active run's ThreadManager the same way spawn_thread/advisor do (via
// configurable.thread_id) and delegates to ctx.runWorkflow, so every agent() in
// the script is a real, isolated child thread streamed over the session SSE.
import { tool } from "@langchain/core/tools"
import { z } from "zod"
import { threadContextFor } from "../thread-context.ts"

const DESCRIPTION = `Run a dynamic workflow: a JavaScript orchestration script that fans out many sub-agents in parallel, then returns ONE synthesized result. Reserve it for work that genuinely needs MANY parallel sub-agents — codebase-wide audits, reviewing every file in a dir, cross-checked research, big multi-phase refactors — or for when the user explicitly asks for a workflow. Do NOT use it for anything a direct answer or one sidekick/spawn_thread brief covers: ordinary features and fixes, short tasks, serial debugging (where accumulated context is the work), or questions. If you don't have a concrete work-list to fan out over (files, findings, items), scout first or delegate instead. Intermediate results stay in script variables — only the final return value enters your context, keeping it lean.

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
  script: z.string().describe("The JavaScript orchestration script (top-level await; `return` the final value)."),
  args: z
    .any()
    .optional()
    .describe("Optional JSON value exposed to the script as the global `args`."),
}

export const workflow = tool(
  async (input: { script: string; args?: unknown }, config?: unknown) => {
    const callerThreadId = (config as any)?.configurable?.thread_id as string | undefined
    const ctx = threadContextFor(callerThreadId)
    if (!ctx || !callerThreadId) {
      return "error: workflow is only available inside an active session run."
    }
    return ctx.runWorkflow({ callerThreadId, script: input.script, args: input.args })
  },
  {
    name: "workflow",
    description: DESCRIPTION,
    schema: z.object(workflowInputShape),
  },
)
