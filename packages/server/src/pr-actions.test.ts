import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "bun:test"
import { reapDecisions, normalizeRemote, buildReviewObjective, type ReapCandidate } from "./pr-actions.ts"
test("link cleanup only selects managed closed PRs",()=>{const entries:ReapCandidate[]=[{key:"o/a#1",link:{sessionId:"1",chunkyManaged:true}},{key:"o/a#2",link:{sessionId:"2",chunkyManaged:false}}]; expect(reapDecisions(entries,new Set())).toHaveLength(1); expect(reapDecisions(entries,new Set(["o/a#1"]))).toHaveLength(0)})
test("normalizes GitHub remotes",()=>{expect(normalizeRemote("git@github.com:Org/Repo.git")).toBe("org/repo");expect(normalizeRemote("https://github.com/Org/Repo")).toBe("org/repo")})

test("review objective embeds scope and quad-panel orchestration safeguards", () => {
  const text = buildReviewObjective({ repo: "acme/widget", number: 42, url: "https://github.com/acme/widget/pull/42", headRef: "fix-pr", baseRefName: "staging", id: "p", title: "x", author: "a", isDraft: false, ciStatus: "none", reviewDecision: "none", unresolvedThreads: 0, labels: [], createdAt: "", updatedAt: "" }, "/tmp/pr-worktree")
  for (const part of ["acme/widget#42", "https://github.com/acme/widget/pull/42", "fix-pr", "origin/staging", "Runtime bug hunter", "Thermo-nuclear quality", "Codex review", "OCR", "IN PARALLEL", "SKIPPED", "spawn_thread", "detach=true", "load_skill", "ocr review", "CROSS-CUTTING SUMMARY", "dedupe by root cause", "gh pr review 42 --repo acme/widget", "--approve", "--comment", "do not fix", "do not commit"]) expect(text).toContain(part)
})


function reviewPr() { return { repo: "acme/widget", number: 42, url: "https://github.com/acme/widget/pull/42", headRef: "fix-pr", baseRefName: "staging", id: "p", title: "x", author: "a", isDraft: false, ciStatus: "none", reviewDecision: "none", unresolvedThreads: 0, labels: [], createdAt: "", updatedAt: "" } as any }
function withSettings(settings: unknown, fn: () => void) { const dir = mkdtempSync(join(tmpdir(), "chunky-review-")); const path = join(dir, "settings.json"); writeFileSync(path, JSON.stringify(settings)); const old = process.env.CHUNKY_SETTINGS; process.env.CHUNKY_SETTINGS = path; try { fn() } finally { if (old === undefined) delete process.env.CHUNKY_SETTINGS; else process.env.CHUNKY_SETTINGS = old; rmSync(dir, { recursive: true, force: true }) } }

test("review objective uses configured skill bindings for all routed lenses", () => {
  withSettings({ skillBindings: { "runtime-bug-hunter": { provider: "anthropic", model: "claude-review", effort: "max", lock: "prefer" }, "thermo-nuclear-code-quality-review": { provider: "openai", model: "quality-x", effort: "medium", lock: "require" }, "chunky-code-review": { provider: "google", model: "gemini-review", effort: "low", lock: "prefer" } } }, () => {
    const text = buildReviewObjective(reviewPr(), "/tmp/review")
    expect(text).toContain('Launch with spawn_thread provider "anthropic" model "claude-review" effort max.')
    expect(text).toContain('Launch with spawn_thread provider "openai" model "quality-x" effort medium.')
    expect(text).toContain('Launch with spawn_thread provider "google" model "gemini-review" effort low.')
  })
})

test("review objective retains defaults when bindings are absent", () => {
  withSettings({}, () => { const text = buildReviewObjective(reviewPr(), "/tmp/review"); expect(text).toContain("premium/highest-capability configured model and `effort: high`"); expect(text).toContain('provider: "codex"` and `effort: high`'); expect(text).toContain("Launch a reviewer that first uses `search_skills`") })
})
