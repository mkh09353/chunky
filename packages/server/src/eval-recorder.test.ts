import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createIsolatedTestState } from "./test-state.ts"

const PREFIX = "chunky-eval-recorder-"
const state = createIsolatedTestState(PREFIX)
process.env.CHUNKY_SETTINGS ||= state.settings
process.env.CHUNKY_DB ||= state.db
process.env.CHUNKY_HOME ||= state.root

const { Store } = await import("./store.ts")
const { setEvalsMode, getEvalsMode } = await import("./settings.ts")
const {
  recordSidekickStart,
  recordSidekickComplete,
  recordSidekickRating,
  evalCandidateDir,
} = await import("./eval-recorder.ts")
const { computeRating } = await import("./tools/rate-delegate.ts")
const { stateDir } = await import("./repos.ts")

const workspace = mkdtempSync(join(tmpdir(), "chunky-eval-ws-"))
writeFileSync(join(workspace, "README.md"), "eval workspace\n")

beforeAll(() => mkdirSync(state.root, { recursive: true }))
afterAll(() => {
  rmSync(workspace, { recursive: true, force: true })
})

function readJson(path: string) {
  return JSON.parse(readFileSync(path, "utf8"))
}

describe("eval recorder", () => {
  test("writes candidate.json with the full un-truncated brief and structured fields", () => {
    setEvalsMode("record")
    expect(getEvalsMode()).toBe("record")
    const sessionId = `eval-on-${crypto.randomUUID()}`
    const delegationId = crypto.randomUUID()
    Store.createSession(sessionId, "Eval on", workspace)
    const longTask = `Implement the retry helper with a very long brief ${"x".repeat(400)}`
    const briefStruct = {
      task: longTask,
      constraints: ["keep the public signature", "no full token scan"],
      done_when: "vitest run passes",
      pointers: "src/net.ts:80",
      seat: "backend",
    }
    const briefComposed = `${longTask}\n\nConstraints:\n- keep the public signature\n\nDone when: vitest run passes\n\nWhere to look:\nsrc/net.ts:80\n\nPersistence clause`
    expect(briefComposed.length).toBeGreaterThan(200)
    recordSidekickStart({
      delegationId,
      sessionId,
      seat: "backend",
      sidekickThreadId: `${sessionId}:sidekick:backend`,
      provider: "codex",
      model: "gpt-5.5",
      effort: "high",
      workspace,
      briefStruct,
      briefComposed,
    })
    const candidatePath = join(evalCandidateDir(delegationId), "candidate.json")
    expect(existsSync(candidatePath)).toBe(true)
    const candidate = readJson(candidatePath)
    expect(candidate.delegationId).toBe(delegationId)
    expect(candidate.sessionId).toBe(sessionId)
    expect(candidate.seat).toBe("backend")
    expect(candidate.briefComposed).toBe(briefComposed)
    expect(candidate.briefComposed.length).toBeGreaterThan(200)
    expect(candidate.briefStruct).toEqual(briefStruct)
    expect(candidate.snapshotRef).toBe(`refs/evals/${delegationId}`)
    expect(candidate.workspace).toBe(workspace)
    expect(candidate.startSeq).toBe(0)
    expect(candidate.provider).toBe("codex")
    expect(candidate.model).toBe("gpt-5.5")
  })

  test("writes nothing when mode is off", () => {
    setEvalsMode("off")
    const sessionId = `eval-off-${crypto.randomUUID()}`
    const delegationId = crypto.randomUUID()
    Store.createSession(sessionId, "Eval off", workspace)
    recordSidekickStart({
      delegationId,
      sessionId,
      sidekickThreadId: `${sessionId}:sidekick`,
      provider: "codex",
      model: "gpt-5.5",
      workspace,
      briefComposed: "short brief",
    })
    expect(existsSync(evalCandidateDir(delegationId))).toBe(false)
    setEvalsMode("record")
  })

  test("writes nothing for a repository-less session", () => {
    setEvalsMode("record")
    const sessionId = `eval-none-${crypto.randomUUID()}`
    const delegationId = crypto.randomUUID()
    Store.createSession(sessionId, "Chat", null, "none")
    recordSidekickStart({
      delegationId,
      sessionId,
      sidekickThreadId: `${sessionId}:sidekick`,
      provider: "codex",
      model: "gpt-5.5",
      workspace,
      briefComposed: "do not record this",
    })
    expect(existsSync(evalCandidateDir(delegationId))).toBe(false)
  })

  test("rating.json captures raw sub-scores", () => {
    setEvalsMode("record")
    const sessionId = `eval-rate-${crypto.randomUUID()}`
    const delegationId = crypto.randomUUID()
    Store.createSession(sessionId, "Eval rate", workspace)
    recordSidekickStart({
      delegationId,
      sessionId,
      sidekickThreadId: `${sessionId}:sidekick`,
      provider: "codex",
      model: "gpt-5.5",
      workspace,
      briefStruct: { task: "fix the retry helper" },
      briefComposed: "fix the retry helper",
    })
    const rating = computeRating({ compliance: 2, correctness: 1, report: 1, exceeded: 0, rework: true })
    recordSidekickRating(delegationId, {
      compliance: 2,
      correctness: 1,
      report: 1,
      exceeded: 0,
      rework: true,
      diagnosis: "ignored the error-path constraint",
      reason: "follow-up needed",
      rating,
      judgeProvider: "zen",
      judgeModel: "glm-5.2",
      ts: 1_700_000_000_000,
    })
    const path = join(evalCandidateDir(delegationId), "rating.json")
    expect(existsSync(path)).toBe(true)
    expect(readJson(path)).toMatchObject({
      compliance: 2,
      correctness: 1,
      report: 1,
      exceeded: 0,
      rework: true,
      diagnosis: "ignored the error-path constraint",
      reason: "follow-up needed",
      rating: 5,
      judgeProvider: "zen",
      judgeModel: "glm-5.2",
    })
  })

  test("recorder failure does not fail the delegation", () => {
    setEvalsMode("record")
    const sessionId = `eval-fail-${crypto.randomUUID()}`
    const delegationId = "not-a-writable-id"
    Store.createSession(sessionId, "Eval fail", workspace)
    mkdirSync(join(stateDir(), "evals", "candidates"), { recursive: true })
    // Occupy this candidate's directory path with a file so mkdir of it fails.
    const blocker = evalCandidateDir(delegationId)
    writeFileSync(blocker, "not a directory")
    expect(() => {
      recordSidekickStart({
        delegationId,
        sessionId,
        sidekickThreadId: `${sessionId}:sidekick`,
        provider: "codex",
        model: "gpt-5.5",
        workspace,
        briefComposed: "should swallow this",
      })
      recordSidekickComplete({
        delegationId,
        sessionId,
        sidekickThreadId: `${sessionId}:sidekick`,
        ok: true,
        finalReport: "ok",
      })
      recordSidekickRating(delegationId, {
        compliance: 3,
        correctness: 3,
        report: 2,
        exceeded: 0,
        rework: false,
        reason: "clean",
        rating: 9,
        judgeProvider: "zen",
        judgeModel: "glm-5.2",
        ts: Date.now(),
      })
    }).not.toThrow()
    rmSync(blocker, { force: true })
  })
})
