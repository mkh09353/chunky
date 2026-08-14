import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createIsolatedTestState } from "./test-state.ts"

const PREFIX = "chunky-eval-replay-"
const state = createIsolatedTestState(PREFIX)
process.env.CHUNKY_SETTINGS ||= state.settings
process.env.CHUNKY_DB ||= state.db
process.env.CHUNKY_HOME ||= state.root

const { Store } = await import("./store.ts")
const { setEvalsMode } = await import("./settings.ts")
const { snapshotWorkspace } = await import("./shadow-git.ts")
const { recordSidekickStart, evalCandidateDir } = await import("./eval-recorder.ts")
const {
  startEvalReplay,
  listEvalReplays,
  evalReplayDir,
  setEvalReplayWorkerForTests,
  resetEvalReplayStateForTests,
  isEvalReplayRunning,
} = await import("./eval-replay.ts")
const { EvalRecorderError } = await import("./eval-recorder.ts")

const workspace = mkdtempSync(join(tmpdir(), "chunky-eval-replay-ws-"))
writeFileSync(join(workspace, "README.md"), "original readme\n")
writeFileSync(join(workspace, "src.ts"), "export const n = 1\n")

beforeAll(() => mkdirSync(state.root, { recursive: true }))
afterEach(() => resetEvalReplayStateForTests())
afterAll(() => {
  rmSync(workspace, { recursive: true, force: true })
})

function readJson(path: string) {
  return JSON.parse(readFileSync(path, "utf8"))
}

async function waitForResult(delegationId: string, replayId: string, timeoutMs = 5_000) {
  const path = join(evalReplayDir(delegationId, replayId), "result.json")
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (existsSync(path)) return readJson(path)
    await Bun.sleep(20)
  }
  throw new Error(`result.json not written for ${replayId}`)
}

function recordCandidate(label: string) {
  setEvalsMode("record")
  const sessionId = `eval-replay-${label}-${crypto.randomUUID()}`
  const delegationId = crypto.randomUUID()
  Store.createSession(sessionId, `Eval replay ${label}`, workspace)
  const commit = snapshotWorkspace(workspace, `refs/evals/${delegationId}`)
  expect(commit).toBeString()
  recordSidekickStart({
    delegationId,
    sessionId,
    sidekickThreadId: `${sessionId}:sidekick`,
    provider: "codex",
    model: "gpt-5.5",
    effort: "high",
    workspace,
    briefStruct: { task: "change src.ts" },
    briefComposed: "change src.ts to export n = 2",
  })
  const candidatePath = join(evalCandidateDir(delegationId), "candidate.json")
  const candidate = readJson(candidatePath)
  candidate.snapshot = commit
  writeFileSync(candidatePath, JSON.stringify(candidate, null, 2))
  return { sessionId, delegationId, commit }
}

describe("eval replay", () => {
  test("restores into a temp workspace, writes a baseline, and records result.json", async () => {
    const { delegationId } = recordCandidate("ok")
    const originalReadme = readFileSync(join(workspace, "README.md"), "utf8")
    const originalSrc = readFileSync(join(workspace, "src.ts"), "utf8")
    setEvalReplayWorkerForTests(async ({ workspace: replayWs, brief, selection }) => {
      expect(brief).toBe("change src.ts to export n = 2")
      expect(selection.provider).toBe("zen")
      expect(selection.model).toBe("glm-5.2")
      expect(selection.effort).toBe("low")
      expect(readFileSync(join(replayWs, "README.md"), "utf8")).toBe("original readme\n")
      expect(readFileSync(join(replayWs, "src.ts"), "utf8")).toBe("export const n = 1\n")
      expect(existsSync(join(replayWs, ".git"))).toBe(true)
      writeFileSync(join(replayWs, "src.ts"), "export const n = 2\n")
      return "updated src.ts"
    })
    const started = startEvalReplay(delegationId, { provider: "zen", model: "glm-5.2", effort: "low" })
    expect(started.status).toBe("running")
    expect(started.replayId).toBeString()

    const result = await waitForResult(delegationId, started.replayId)
    expect(result.replayId).toBe(started.replayId)
    expect(result.provider).toBe("zen")
    expect(result.model).toBe("glm-5.2")
    expect(result.effort).toBe("low")
    expect(result.ok).toBe(true)
    expect(result.finalReport).toBe("updated src.ts")
    expect(typeof result.startedAt).toBe("number")
    expect(typeof result.completedAt).toBe("number")
    expect(result.diff).toContain("export const n = 2")
    expect(result.diff).not.toContain("original readme")

    expect(readFileSync(join(workspace, "README.md"), "utf8")).toBe(originalReadme)
    expect(readFileSync(join(workspace, "src.ts"), "utf8")).toBe(originalSrc)

    const listed = listEvalReplays(delegationId)
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({
      replayId: started.replayId,
      provider: "zen",
      model: "glm-5.2",
      effort: "low",
      status: "done",
      ok: true,
    })
    expect(isEvalReplayRunning(delegationId)).toBe(false)
  })

  test("409s when a replay for the same candidate is already running", async () => {
    const { delegationId } = recordCandidate("busy")
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    setEvalReplayWorkerForTests(async () => {
      await gate
      return "later"
    })
    const first = startEvalReplay(delegationId)
    expect(first.status).toBe("running")
    expect(isEvalReplayRunning(delegationId)).toBe(true)
    try {
      startEvalReplay(delegationId)
      throw new Error("expected concurrent replay to 409")
    } catch (err) {
      expect(err).toBeInstanceOf(EvalRecorderError)
      expect((err as InstanceType<typeof EvalRecorderError>).status).toBe(409)
    }
    release()
    await waitForResult(delegationId, first.replayId)
  })

  test("marks result error when the injected worker fails", async () => {
    const { delegationId } = recordCandidate("err")
    setEvalReplayWorkerForTests(async () => {
      throw new Error("injected boom")
    })
    const started = startEvalReplay(delegationId)
    const result = await waitForResult(delegationId, started.replayId)
    expect(result.ok).toBe(false)
    expect(result.finalReport).toContain("injected boom")
    const listed = listEvalReplays(delegationId)
    expect(listed[0]?.status).toBe("error")
    expect(listed[0]?.ok).toBe(false)
  })
})
