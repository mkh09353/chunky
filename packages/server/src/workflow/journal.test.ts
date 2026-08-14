// Journaled same-process resume: wrap a fake host (no ThreadManager) and assert
// write / replay / divergence / exhausted-continuation / parallel / incognito.
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentEvent } from "@chunky/protocol"
import type { AgentSelectionOverride } from "../providers/registry.ts"
import { runWorkflowScript, type WorkflowHost } from "./engine.ts"
import {
  annotateWorkflowResult,
  loadWorkflowJournal,
  prepareJournaledHost,
  workflowJournalPath,
} from "./journal.ts"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs.length = 0
})

function tempState(): string {
  const dir = mkdtempSync(join(tmpdir(), "chunky-workflow-journal-"))
  dirs.push(dir)
  return dir
}

interface SpawnCall {
  title: string
  instructions: string
  selection?: AgentSelectionOverride
}

function makeInner(opts: {
  runId?: string
  reply?: (call: SpawnCall) => string | Promise<string>
  delayFor?: (call: SpawnCall) => number
} = {}) {
  const events: AgentEvent[] = []
  const spawns: SpawnCall[] = []
  const host: WorkflowHost = {
    runId: opts.runId ?? "run-journal",
    concurrency: 4,
    emit: (ev) => events.push(ev),
    async spawn(call) {
      spawns.push(call)
      const delay = opts.delayFor?.(call) ?? 0
      if (delay) await new Promise((r) => setTimeout(r, delay))
      return opts.reply ? await opts.reply(call) : `reply:${call.instructions}`
    },
  }
  return { host, events, spawns }
}

function prepare(inner: WorkflowHost, script: string, extra: { args?: unknown; resumeFrom?: string; incognito?: boolean } = {}) {
  const baseDir = tempState()
  return { ...prepareJournaledHost(inner, { script, baseDir, ...extra }), baseDir }
}

describe("workflow journal", () => {
  test("writes a header plus one agent entry during a live run", async () => {
    const { host: inner, spawns } = makeInner()
    const script = `return await agent('do a thing', { label: 'x' })`
    const { host, runId, baseDir } = prepare(inner, script)
    const out = await runWorkflowScript(host, script)
    expect(out).toBe("reply:do a thing")
    expect(spawns).toHaveLength(1)
    const loaded = loadWorkflowJournal(runId, baseDir)
    expect(loaded.header.runId).toBe(runId)
    expect(loaded.entries).toHaveLength(1)
    expect(loaded.entries[0]).toMatchObject({ seq: 0, kind: "agent", result: "reply:do a thing" })
    expect(readFileSync(workflowJournalPath(runId, baseDir), "utf8").trim().split("\n")).toHaveLength(2)
  })

  test("resume replays agent results without spawning", async () => {
    const first = makeInner()
    const script = `return await agent('only once')`
    const prepared = prepare(first.host, script)
    expect(await runWorkflowScript(prepared.host, script)).toBe("reply:only once")

    const second = makeInner({ runId: prepared.runId })
    const resumed = prepareJournaledHost(second.host, {
      script,
      resumeFrom: prepared.runId,
      baseDir: prepared.baseDir,
    })
    const out = await runWorkflowScript(resumed.host, script)
    expect(out).toBe("reply:only once")
    expect(second.spawns).toHaveLength(0)
  })

  test("divergence on edited script, changed args, or mismatched agent call", async () => {
    const first = makeInner()
    const script = `return await agent('alpha')`
    const prepared = prepare(first.host, script, { args: { n: 1 } })
    await runWorkflowScript(prepared.host, script)

    expect(() =>
      prepareJournaledHost(makeInner().host, {
        script: `return await agent('beta')`,
        args: { n: 1 },
        resumeFrom: prepared.runId,
        baseDir: prepared.baseDir,
      }),
    ).toThrow(/script does not match the journaled run/)

    expect(() =>
      prepareJournaledHost(makeInner().host, {
        script,
        args: { n: 2 },
        resumeFrom: prepared.runId,
        baseDir: prepared.baseDir,
      }),
    ).toThrow(/args do not match the journaled run/)

    const two = `const a = await agent('one')\nreturn await agent('two') + a`
    const live = makeInner()
    const twoPrep = prepare(live.host, two)
    await runWorkflowScript(twoPrep.host, two)
    const path = workflowJournalPath(twoPrep.runId, twoPrep.baseDir)
    const lines = readFileSync(path, "utf8").split("\n")
    const entry = JSON.parse(lines[1]!)
    entry.reqHash = "deadbeef"
    lines[1] = JSON.stringify(entry)
    writeFileSync(path, lines.join("\n"))
    const diverged = prepareJournaledHost(makeInner().host, {
      script: two,
      resumeFrom: twoPrep.runId,
      baseDir: twoPrep.baseDir,
    })
    const out = await runWorkflowScript(diverged.host, two)
    expect(out).toContain("workflow journal divergence")
    expect(out).toContain("nondeterministic or was edited mid-run")
    expect(out).not.toContain("reply:one")
  })

  test("exhausted journal continues live and appends", async () => {
    const full = `const a = await agent('first')\nconst b = await agent('second')\nreturn a + ':' + b`
    const throwing = makeInner({
      reply: (c) => {
        if (c.instructions === "second") throw new Error("boom")
        return `live:${c.instructions}`
      },
    })
    const started = prepare(throwing.host, full)
    const failed = await runWorkflowScript(started.host, full)
    expect(failed).toContain("workflow error: boom")
    expect(loadWorkflowJournal(started.runId, started.baseDir).entries).toHaveLength(1)

    const resumeInner = makeInner({
      reply: (c) => `resumed:${c.instructions}`,
    })
    const resumed = prepareJournaledHost(resumeInner.host, {
      script: full,
      resumeFrom: started.runId,
      baseDir: started.baseDir,
    })
    const out = await runWorkflowScript(resumed.host, full)
    expect(out).toBe("live:first:resumed:second")
    expect(resumeInner.spawns.map((s) => s.instructions)).toEqual(["second"])
    expect(loadWorkflowJournal(started.runId, started.baseDir).entries).toHaveLength(2)
  })

  test("parallel out-of-order completion resumes without false divergence", async () => {
    const script = `const r = await parallel([
      () => agent('slow'),
      () => agent('fast'),
    ])
    return JSON.stringify(r)`
    const first = makeInner({
      delayFor: (c) => (c.instructions === "slow" ? 30 : 1),
    })
    const prepared = prepare(first.host, script)
    const out = await runWorkflowScript(prepared.host, script)
    expect(JSON.parse(out)).toEqual(["reply:slow", "reply:fast"])
    const loaded = loadWorkflowJournal(prepared.runId, prepared.baseDir)
    expect(loaded.entries.map((e) => e.seq)).toEqual([0, 1])
    expect(loaded.entries.map((e) => e.result)).toEqual(["reply:slow", "reply:fast"])

    const second = makeInner()
    const resumed = prepareJournaledHost(second.host, {
      script,
      resumeFrom: prepared.runId,
      baseDir: prepared.baseDir,
    })
    const replayed = await runWorkflowScript(resumed.host, script)
    expect(JSON.parse(replayed)).toEqual(["reply:slow", "reply:fast"])
    expect(second.spawns).toHaveLength(0)
  })

  test("incognito skips journaling and cannot resume", async () => {
    const script = `return await agent('secret')`
    const { host: inner, spawns } = makeInner()
    const baseDir = tempState()
    const prepared = prepareJournaledHost(inner, { script, incognito: true, baseDir })
    expect(prepared.journaled).toBe(false)
    expect(await runWorkflowScript(prepared.host, script)).toBe("reply:secret")
    expect(spawns).toHaveLength(1)
    expect(() => loadWorkflowJournal(prepared.runId, baseDir)).toThrow(/no workflow journal/)

    expect(() =>
      prepareJournaledHost(inner, { script, incognito: true, resumeFrom: "anything", baseDir }),
    ).toThrow(/incognito/)
  })

  test("failed result mentions resume_from_run_id; success is unchanged", () => {
    expect(annotateWorkflowResult("abc", "hello", true)).toBe("hello")
    expect(annotateWorkflowResult("abc", "workflow error: boom", true)).toContain("resume_from_run_id")
    expect(annotateWorkflowResult("abc", "workflow error: boom", true)).toContain("Run id: abc")
    expect(annotateWorkflowResult("abc", "workflow error: boom", false)).toBe("workflow error: boom")
  })

  test("schema-parse null is journaled as the script-visible result", async () => {
    const script = `return await agent('audit', { schema: { type: 'object' } })`
    const first = makeInner({ reply: () => "not json" })
    const prepared = prepare(first.host, script)
    expect(await runWorkflowScript(prepared.host, script)).toBe("workflow finished (no value returned).")
    expect(first.spawns).toHaveLength(2) // live + retry
    expect(loadWorkflowJournal(prepared.runId, prepared.baseDir).entries[0]!.result).toBeNull()

    const second = makeInner()
    const resumed = prepareJournaledHost(second.host, {
      script,
      resumeFrom: prepared.runId,
      baseDir: prepared.baseDir,
    })
    expect(await runWorkflowScript(resumed.host, script)).toBe("workflow finished (no value returned).")
    expect(second.spawns).toHaveLength(0)
  })
})
