import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { gzipSync } from "node:zlib"
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
  evalSuiteDir,
  evalsResponse,
  listEvalCandidates,
  getEvalCandidateDetail,
  readEvalTranscript,
  promoteEvalCandidate,
  deleteEvalCandidate,
  EvalRecorderError,
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

  test("list/detail skip malformed dirs and sort newest-first", () => {
    setEvalsMode("record")
    const sessionId = `eval-list-${crypto.randomUUID()}`
    Store.createSession(sessionId, "Eval list", workspace)
    const older = crypto.randomUUID()
    const newer = crypto.randomUUID()
    recordSidekickStart({
      delegationId: older,
      sessionId,
      seat: "backend",
      sidekickThreadId: `${sessionId}:sidekick:backend`,
      provider: "codex",
      model: "gpt-5.5",
      workspace,
      briefStruct: { task: "older task" },
      briefComposed: "older task",
    })
    recordSidekickStart({
      delegationId: newer,
      sessionId,
      sidekickThreadId: `${sessionId}:sidekick`,
      provider: "zen",
      model: "glm-5.2",
      workspace,
      briefComposed: "x".repeat(250),
    })
    const olderPath = join(evalCandidateDir(older), "candidate.json")
    const olderJson = JSON.parse(readFileSync(olderPath, "utf8"))
    olderJson.startedAt = 1_000
    writeFileSync(olderPath, JSON.stringify(olderJson, null, 2))
    const newerPath = join(evalCandidateDir(newer), "candidate.json")
    const newerJson = JSON.parse(readFileSync(newerPath, "utf8"))
    newerJson.startedAt = 2_000
    writeFileSync(newerPath, JSON.stringify(newerJson, null, 2))

    const junk = join(stateDir(), "evals", "candidates", `junk-${crypto.randomUUID()}`)
    mkdirSync(junk, { recursive: true })
    writeFileSync(join(junk, "candidate.json"), "{not-json")

    recordSidekickComplete({
      delegationId: older,
      sessionId,
      sidekickThreadId: `${sessionId}:sidekick:backend`,
      ok: true,
      finalReport: "done",
    })

    const listed = listEvalCandidates()
    const ours = listed.filter((row) => row.delegationId === older || row.delegationId === newer)
    expect(ours.map((row) => row.delegationId)).toEqual([newer, older])
    expect(listed.some((row) => row.delegationId.startsWith("junk-"))).toBe(false)
    expect(ours[0]!.task).toBe("x".repeat(200))
    expect(ours[1]!.task).toBe("older task")
    expect(ours[1]!.ok).toBe(true)
    expect(ours[1]!.seat).toBe("backend")
    expect(ours[0]!.ok).toBeUndefined()

    const detail = getEvalCandidateDetail(older)
    expect(detail.candidate.delegationId).toBe(older)
    expect(detail.report?.ok).toBe(true)
    expect(detail.promoted).toBe(false)

    expect(() => getEvalCandidateDetail("missing-id")).toThrow(EvalRecorderError)
    try { getEvalCandidateDetail("missing-id") } catch (err) {
      expect((err as InstanceType<typeof EvalRecorderError>).status).toBe(404)
    }
  })

  test("promote copies into suite without mutating the candidate, delete is gated", () => {
    setEvalsMode("record")
    const sessionId = `eval-promote-${crypto.randomUUID()}`
    const delegationId = crypto.randomUUID()
    Store.createSession(sessionId, "Eval promote", workspace)
    recordSidekickStart({
      delegationId,
      sessionId,
      sidekickThreadId: `${sessionId}:sidekick`,
      provider: "codex",
      model: "gpt-5.5",
      workspace,
      briefStruct: { task: "promote me" },
      briefComposed: "promote me",
    })
    recordSidekickComplete({
      delegationId,
      sessionId,
      sidekickThreadId: `${sessionId}:sidekick`,
      ok: false,
      finalReport: "failed",
    })
    const rating = computeRating({ compliance: 1, correctness: 1, report: 1, exceeded: 0, rework: true })
    recordSidekickRating(delegationId, {
      compliance: 1,
      correctness: 1,
      report: 1,
      exceeded: 0,
      rework: true,
      diagnosis: "missed the constraint",
      reason: "follow-up",
      rating,
      judgeProvider: "zen",
      judgeModel: "glm-5.2",
      ts: 1_800_000_000_000,
    })
    const before = readFileSync(join(evalCandidateDir(delegationId), "candidate.json"), "utf8")
    const detail = promoteEvalCandidate(delegationId, "hard")
    expect(detail.promoted).toBe(true)
    expect(detail.report?.ok).toBe(false)
    expect(detail.rating?.diagnosis).toBe("missed the constraint")
    expect(readFileSync(join(evalCandidateDir(delegationId), "candidate.json"), "utf8")).toBe(before)
    expect(existsSync(join(evalCandidateDir(delegationId), "promoted.json"))).toBe(false)
    const promoted = readJson(join(evalSuiteDir(delegationId), "promoted.json"))
    expect(promoted.bucket).toBe("hard")
    expect(typeof promoted.promotedAt).toBe("number")
    expect(existsSync(join(evalSuiteDir(delegationId), "candidate.json"))).toBe(true)

    const listed = listEvalCandidates().find((row) => row.delegationId === delegationId)
    expect(listed?.promoted).toBe(true)
    expect(listed?.rating).toBe(rating)
    expect(listed?.rework).toBe(true)
    expect(listed?.diagnosis).toBe("missed the constraint")

    try {
      promoteEvalCandidate(delegationId, "random")
      throw new Error("expected already-promoted")
    } catch (err) {
      expect(err).toBeInstanceOf(EvalRecorderError)
      expect((err as InstanceType<typeof EvalRecorderError>).status).toBe(409)
    }
    try {
      deleteEvalCandidate(delegationId)
      throw new Error("expected promoted delete to fail")
    } catch (err) {
      expect(err).toBeInstanceOf(EvalRecorderError)
      expect((err as InstanceType<typeof EvalRecorderError>).status).toBe(409)
    }
    expect(existsSync(evalCandidateDir(delegationId))).toBe(true)
  })

  test("delete prunes a non-promoted candidate and transcript is gunzipped JSONL", () => {
    setEvalsMode("record")
    const sessionId = `eval-delete-${crypto.randomUUID()}`
    const keepId = crypto.randomUUID()
    const dropId = crypto.randomUUID()
    Store.createSession(sessionId, "Eval delete", workspace)
    recordSidekickStart({
      delegationId: keepId,
      sessionId,
      sidekickThreadId: `${sessionId}:sidekick`,
      provider: "codex",
      model: "gpt-5.5",
      workspace,
      briefComposed: "keep",
    })
    recordSidekickStart({
      delegationId: dropId,
      sessionId,
      sidekickThreadId: `${sessionId}:sidekick`,
      provider: "codex",
      model: "gpt-5.5",
      workspace,
      briefComposed: "drop",
    })
    const line = JSON.stringify({ seq: 1, json: JSON.stringify({ type: "message.delta", text: "hello" }) }) + "\n"
    writeFileSync(join(evalCandidateDir(keepId), "transcript.jsonl.gz"), gzipSync(line))
    expect(readEvalTranscript(keepId)).toBe(line)
    try { readEvalTranscript(dropId) } catch (err) {
      expect(err).toBeInstanceOf(EvalRecorderError)
      expect((err as InstanceType<typeof EvalRecorderError>).status).toBe(404)
    }

    deleteEvalCandidate(dropId)
    expect(existsSync(evalCandidateDir(dropId))).toBe(false)
    try { deleteEvalCandidate(dropId) } catch (err) {
      expect(err).toBeInstanceOf(EvalRecorderError)
      expect((err as InstanceType<typeof EvalRecorderError>).status).toBe(404)
    }
    expect(listEvalCandidates().some((row) => row.delegationId === dropId)).toBe(false)

    const stats = evalsResponse("record")
    expect(stats.mode).toBe("record")
    expect(stats.stats.candidates).toBeGreaterThanOrEqual(1)
    expect(stats.stats.bytes).toBeGreaterThan(0)
    expect(typeof stats.stats.promoted).toBe("number")
  })
})
