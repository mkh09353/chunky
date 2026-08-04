import { expect, test } from "bun:test"
import { reapDecisions, normalizeRemote, buildReviewObjective, type ReapCandidate } from "./pr-actions.ts"
test("link cleanup only selects managed closed PRs",()=>{const entries:ReapCandidate[]=[{key:"o/a#1",link:{sessionId:"1",chunkyManaged:true}},{key:"o/a#2",link:{sessionId:"2",chunkyManaged:false}}]; expect(reapDecisions(entries,new Set())).toHaveLength(1); expect(reapDecisions(entries,new Set(["o/a#1"]))).toHaveLength(0)})
test("normalizes GitHub remotes",()=>{expect(normalizeRemote("git@github.com:Org/Repo.git")).toBe("org/repo");expect(normalizeRemote("https://github.com/Org/Repo")).toBe("org/repo")})

test("review objective embeds scope and quad-panel orchestration safeguards", () => {
  const text = buildReviewObjective({ repo: "acme/widget", number: 42, url: "https://github.com/acme/widget/pull/42", headRef: "fix-pr", baseRefName: "staging", id: "p", title: "x", author: "a", isDraft: false, ciStatus: "none", reviewDecision: "none", unresolvedThreads: 0, labels: [], createdAt: "", updatedAt: "" }, "/tmp/pr-worktree")
  for (const part of ["acme/widget#42", "https://github.com/acme/widget/pull/42", "fix-pr", "origin/staging", "Runtime bug hunter", "Thermo-nuclear quality", "Codex review", "OCR", "IN PARALLEL", "SKIPPED", "spawn_thread", "detach=true", "load_skill", "ocr review", "CROSS-CUTTING SUMMARY", "dedupe by root cause", "gh pr review 42 --repo acme/widget", "--approve", "--comment", "do not fix", "do not commit"]) expect(text).toContain(part)
})
