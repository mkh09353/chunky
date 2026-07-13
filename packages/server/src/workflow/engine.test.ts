// Deterministic workflow-engine test: run real scripts through the AsyncFunction
// sandbox against a FAKE host (no models, no threads, no credentials) and assert
// the primitives (agent/parallel/pipeline/phase/log), structured output, the
// concurrency cap, the tier→selection policy, and the determinism/sandbox guards.
//
// Run:  bun test packages/server/src/workflow/engine.test.ts
import { describe, expect, test } from "bun:test"
import type { AgentEvent } from "@chunky/protocol"
import type { AgentSelectionOverride } from "../providers/registry.ts"
import { runWorkflowScript, workflowConcurrency, type WorkflowHost } from "./engine.ts"
import { runScript } from "./runtime.ts"

interface SpawnCall {
  title: string
  instructions: string
  selection?: AgentSelectionOverride
}

/** A fake host that records spawns, tracks live concurrency, and lets a test
 *  script drive the reply per call. `reply` maps instructions → returned text. */
function makeHost(opts: {
  concurrency?: number
  reply?: (call: SpawnCall) => string | Promise<string>
  delayMs?: number
} = {}) {
  const events: AgentEvent[] = []
  const spawns: SpawnCall[] = []
  let active = 0
  let maxActive = 0
  const host: WorkflowHost = {
    runId: "run-test",
    ownerThreadId: undefined,
    concurrency: opts.concurrency ?? 4,
    emit: (ev) => events.push(ev),
    async spawn(call) {
      spawns.push(call)
      active++
      maxActive = Math.max(maxActive, active)
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs))
      const text = opts.reply ? await opts.reply(call) : `reply:${call.title}`
      active--
      return text
    },
    tierOverride: (tier) =>
      tier === "big" ? { effort: "high" } : tier === "small" ? { effort: "low" } : undefined,
    routeOverride: ({ tags }) => {
      if (tags?.includes("blocked")) throw new Error("WORKFLOW_ROUTING_REQUIRES_USER: choose a model")
      return tags?.includes("frontend") ? { provider: "anthropic", model: "opus[1m]", effort: "high" } : undefined
    },
  }
  return { host, events, spawns, maxActive: () => maxActive }
}

describe("workflow engine — primitives", () => {
  test("agent() spawns and returns the sub-agent text", async () => {
    const { host, spawns } = makeHost({ reply: () => "the answer" })
    const out = await runWorkflowScript(host, `return await agent('do a thing', { label: 'x' })`)
    expect(out).toBe("the answer")
    expect(spawns).toHaveLength(1)
    expect(spawns[0]!.title).toBe("x")
    expect(spawns[0]!.instructions).toBe("do a thing")
  })

  test("parallel() runs thunks; a throwing thunk becomes null", async () => {
    const { host } = makeHost({
      reply: (c) => (c.instructions.includes("boom") ? Promise.reject(new Error("boom")) : "ok"),
    })
    const out = await runWorkflowScript(
      host,
      `const r = await parallel([
         () => agent('one'),
         () => agent('boom'),
         () => agent('three'),
       ])
       return JSON.stringify(r)`,
    )
    expect(JSON.parse(out)).toEqual(["ok", null, "ok"])
  })

  test("pipeline() flows each item through stages independently", async () => {
    const { host } = makeHost()
    const out = await runWorkflowScript(
      host,
      `const r = await pipeline(
         ['a', 'b'],
         (item) => agent('stage1 ' + item),
         (prev, item, i) => item + ':' + i,
       )
       return JSON.stringify(r)`,
    )
    expect(JSON.parse(out)).toEqual(["a:0", "b:1"])
  })

  test("phase() and log() emit narrator events; phase prefixes agent titles", async () => {
    const { host, events, spawns } = makeHost()
    await runWorkflowScript(
      host,
      `phase('Review')
       log('scanning')
       await agent('audit', { label: 'file.ts' })`,
    )
    const phase = events.find((e) => e.type === "workflow.phase")
    expect(phase && phase.type === "workflow.phase" && phase.title).toBe("Review")
    const log = events.find((e) => e.type === "workflow.log" && e.message === "scanning")
    expect(log).toBeTruthy()
    // The agent inherits the current phase in its title.
    expect(spawns[0]!.title).toBe("Review · file.ts")
  })

  test("args is available to the script", async () => {
    const { host } = makeHost()
    const out = await runWorkflowScript(host, `return args.name`, { name: "chunky" })
    expect(out).toBe("chunky")
  })
})

describe("workflow engine — structured output", () => {
  test("schema returns a parsed object, even inside a code fence", async () => {
    const { host } = makeHost({ reply: () => '```json\n{"severity":"high","issues":["x"]}\n```' })
    const out = await runWorkflowScript(
      host,
      `const r = await agent('audit', { schema: { type: 'object' } })
       return JSON.stringify(r)`,
    )
    expect(JSON.parse(out)).toEqual({ severity: "high", issues: ["x"] })
  })

  test("schema retries once then yields null on unparseable output", async () => {
    let calls = 0
    const { host, spawns } = makeHost({
      reply: () => {
        calls++
        return "sorry, no JSON here"
      },
    })
    const out = await runWorkflowScript(
      host,
      `const r = await agent('audit', { schema: { type: 'object' } })
       return r === null ? 'was-null' : JSON.stringify(r)`,
    )
    expect(out).toBe("was-null")
    expect(calls).toBe(2) // original + one corrective retry
    expect(spawns[1]!.title).toContain("(retry)")
  })
})

describe("workflow engine — concurrency + tiers", () => {
  test("agent() concurrency never exceeds host.concurrency", async () => {
    const { host, maxActive } = makeHost({ concurrency: 2, delayMs: 10 })
    await runWorkflowScript(
      host,
      `await parallel(Array.from({ length: 8 }, (_, i) => () => agent('t' + i)))`,
    )
    expect(maxActive()).toBeLessThanOrEqual(2)
  })

  test("tier maps to a selection override; explicit fields win over tier", async () => {
    const { host, spawns } = makeHost()
    await runWorkflowScript(
      host,
      `await agent('a', { tier: 'small' })
       await agent('b', { tier: 'big' })
       await agent('c', { tier: 'small', model: 'gpt-5.5', provider: 'codex' })
       await agent('d')`,
    )
    expect(spawns[0]!.selection).toEqual({ effort: "low" })
    expect(spawns[1]!.selection).toEqual({ effort: "high" })
    // Explicit provider/model present → tier ignored, explicit fields used.
    expect(spawns[2]!.selection).toEqual({ provider: "codex", model: "gpt-5.5" })
    // No tier, no explicit fields → inherit (undefined).
    expect(spawns[3]!.selection).toBeUndefined()
  })

  test("semantic tags route through the host while explicit provider/model still win", async () => {
    const { host, spawns } = makeHost()
    await runWorkflowScript(
      host,
      `await agent('frontend', { tags: ['frontend'] })
       await agent('explicit', { tags: ['frontend'], provider: 'grok', model: 'grok-4.5', effort: 'high' })`,
    )
    expect(spawns[0]!.selection).toEqual({ provider: "anthropic", model: "opus[1m]", effort: "high" })
    expect(spawns[1]!.selection).toEqual({ provider: "grok", model: "grok-4.5", effort: "high" })
  })

  test("pipeline surfaces routing decisions instead of silently returning null", async () => {
    const { host } = makeHost()
    const out = await runWorkflowScript(host, `return await pipeline(['ui'], item => agent(item, { tags: ['blocked'] }))`)
    expect(out).toContain("WORKFLOW_ROUTING_REQUIRES_USER")
  })

  test("workflowConcurrency() is a sane positive cap", () => {
    const c = workflowConcurrency()
    expect(c).toBeGreaterThanOrEqual(1)
    expect(c).toBeLessThanOrEqual(16)
  })
})

describe("workflow sandbox — determinism + isolation", () => {
  test("Math.random() and Date.now()/argless new Date() throw; safe uses work", async () => {
    await expect(runScript(`return Math.random()`, {})).rejects.toThrow(/Math\.random/)
    await expect(runScript(`return Date.now()`, {})).rejects.toThrow(/Date\.now/)
    await expect(runScript(`return new Date()`, {})).rejects.toThrow(/Date/)
    // Deterministic uses of the same globals still work.
    expect(await runScript(`return Math.max(2, 5, 3)`, {})).toBe(5)
    expect(await runScript(`return new Date(0).getTime()`, {})).toBe(0)
  })

  test("host escapes are shadowed inside the script", async () => {
    const out = await runScript(
      `return [typeof process, typeof require, typeof fetch, typeof globalThis].join(',')`,
      {},
    )
    expect(out).toBe("undefined,undefined,undefined,undefined")
  })

  test("a Claude-Code-style `export const meta` script parses and runs", async () => {
    const { host } = makeHost({ reply: () => "done" })
    const script = `export const meta = { name: 'demo', description: 'x' }
      return await agent('go')`
    const out = await runWorkflowScript(host, script)
    expect(out).toBe("done")
  })
})
