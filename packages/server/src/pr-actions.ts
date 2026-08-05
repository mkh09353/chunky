import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import { join, basename } from "node:path"
import type { PrActionRequest, PrActionResponse, PrSummary } from "@chunky/protocol"
import { stateDir, listRepos, addRepo, repoId } from "./repos.ts"
import { Store } from "./store.ts"
import { deliverToSession } from "./session-bus.ts"
import { emitToSession } from "./session-bus.ts"
import { goalKickoffPrompt, toSnapshot, type Goal } from "./goal.ts"
import { getGithubConfig, getSkillBinding } from "./settings.ts"

export interface PrLink { sessionId: string; clonePath?: string; chunkyManaged: boolean }
type Links = Record<string, PrLink>
const file = () => join(stateDir(), "github-pr-links.json")
export function loadPrLinks(): Links { try { return JSON.parse(readFileSync(file(), "utf8")) as Links } catch { return {} } }
function save(x: Links) { mkdirSync(stateDir(), { recursive:true }); writeFileSync(file(), JSON.stringify(x,null,2), {mode:0o600}) }
export function linkKey(repo:string, number:number) { return `${repo}#${number}` }
export function getPrLink(repo:string, number:number) { return loadPrLinks()[linkKey(repo,number)] }
export function linkPr(repo:string, number:number, link:PrLink) { const x=loadPrLinks(); x[linkKey(repo,number)]=link; save(x) }
export function deletePrLink(repo:string, number:number) { const x=loadPrLinks(); delete x[linkKey(repo,number)]; save(x) }
export function joinPrLinks(rows:PrSummary[]):PrSummary[] { const x=loadPrLinks(); return rows.map(r=>({...r, ...(x[linkKey(r.repo,r.number)]?.sessionId ? {linkedSessionId:x[linkKey(r.repo,r.number)].sessionId}: {})})) }

async function git(cwd:string,args:string[]):Promise<string> { const p=Bun.spawn(["git",...args],{cwd,stdout:"pipe",stderr:"pipe"}); const out=await new Response(p.stdout).text(); await p.exited; if(p.exitCode!==0) throw new Error("git operation failed"); return out.trim() }
async function checkout(repo:string, org:string, number:number, head:string, token?:string):Promise<{path:string;managed:boolean}> {
 const existing=listRepos().repos.find(r=>basename(r.path)===repo.split("/").pop() || (()=>false)())
 let base=existing?.path
 if(!base){ const dir=join(stateDir(),"github",org,repo.split("/").pop()!); mkdirSync(join(stateDir(),"github",org),{recursive:true}); const url=token?`https://x-access-token:${encodeURIComponent(token)}@github.com/${repo}.git`:`https://github.com/${repo}.git`; await git(stateDir(),["clone",url,dir]); addRepo(dir); base=dir }
 await git(base,["fetch","origin",head]); const path=join(stateDir(),"github","worktrees",`${repo.split("/").pop()}-pr${number}`); mkdirSync(join(stateDir(),"github","worktrees"),{recursive:true}); if(existsSync(path)) await git(base,["worktree","remove","--force",path]).catch(()=>{}); await git(base,["worktree","add","--force",path,`origin/${head}`]); return {path,managed:true}
}
function objective(action:"resolve"|"review", pr:PrSummary, workdir:string):string {
  return `Resolve every unresolved review thread on ${pr.repo}#${pr.number}. PR: ${pr.url}. Branch: ${pr.headRef}. Work in ${workdir}. Fetch the unresolved review threads with gh api graphql, address each comment with tested code changes, commit and push to the PR branch, reply to each thread explaining the fix and resolve it with the resolveReviewThread GraphQL mutation, then re-request review from the reviewers who left the comments using gh api. Verify the changes and report the commit and review actions.`
}

export type ReviewPr = PrSummary & { baseRefName?: string }

/** Build the review-only quad-panel orchestrator brief. */
export function buildReviewObjective(pr: ReviewPr, workdir: string): string {
  const base = pr.baseRefName || "main"
  // Skill bindings are the user's review-workflow configuration surface; in this panel they are authoritative routing.
  const launch = (skill: string, fallback: string) => {
    const binding = getSkillBinding(skill)
    return binding ? `Launch with spawn_thread provider "${binding.provider}" model "${binding.model}"${binding.effort ? ` effort ${binding.effort}` : ""}.` : fallback
  }
  const bugHunterLaunch = launch("runtime-bug-hunter", "Launch with the premium/highest-capability configured model and `effort: high`.")
  const thermoLaunch = launch("thermo-nuclear-code-quality-review", "Launch a reviewer that first uses `search_skills` for `thermo-nuclear-code-quality-review`, then loads `thermo-nuclear-code-quality-review` with `load_skill`.")
  const chunkyLaunch = launch("chunky-code-review", 'Launch with `spawn_thread` using `provider: "codex"` and `effort: high`.')
  return `You are the ORCHESTRATOR ONLY for a four-reviewer PR panel. This is strictly REVIEW-ONLY: do not review the code yourself, do not fix anything, do not edit files, do not commit, and do not push. Your job is to scope the PR, launch all four independent reviewers in parallel using Chunky's delegation tools, collect every report, synthesize without inventing findings, and post the final review.

PR scope (already resolved by the server): ${pr.repo}#${pr.number}
URL: ${pr.url}
Head branch: ${pr.headRef}
Base branch: ${base}
Workdir: ${workdir}
Diff base: origin/${base}

## Step 1 — scope

Do not inspect or review the implementation yourself. First run \`git fetch origin ${base} --quiet\` best-effort (ignore failure), then \`git diff --stat origin/${base}...HEAD\` as a sanity check. If the diff is empty, record that the panel had no diff and stop without posting findings. Run \`ocr --version\` only to determine whether OCR is available; never install or reconfigure it. Use search_tools/search_skills to check whether the \`thermo-nuclear-code-quality-review\` skill is available. The PR identity above is authoritative; do not guess another PR or base.

## Step 2 — launch all four reviewers IN PARALLEL

In ONE turn, launch all four independent reviewers concurrently using Chunky's own delegation tools (\`spawn_thread\` with \`detach=true\` for each, or the workflow tool). Do not run one reviewer and wait before launching the others. Each reviewer is isolated and review-only. If a reviewer cannot launch, fails, or its tool/provider is unavailable, record that section as SKIPPED/FAILED with the error and continue; one failure never aborts the panel.

### A. Runtime bug hunter (premium/highest capability, effort high)

${bugHunterLaunch} First use \`search_skills\` and \`load_skill\` for \`runtime-bug-hunter\`, then apply it to the diff against \`origin/${base}...HEAD\`. If the skill is unavailable, use this fallback: find bugs caused by the diff, reproduce each at runtime before reporting, discard unreproduced findings, and report exact steps, observed-vs-expected behavior, evidence, severity, and file:line. Review-only; do not edit, fix, commit, or push.

### B. Thermo-nuclear quality

${thermoLaunch} Apply that skill exactly as written to the diff against \`origin/${base}\`. Preserve its verdict, prioritized findings, approval bar, and presumptive blockers. This reviewer is read-only and must not modify files. If the skill is unavailable, skip this section with a clear note; do not substitute an invented quality review.

### C. Codex review (real model diversity)

${chunkyLaunch} First use \`search_skills\` and \`load_skill\` for \`chunky-code-review\`, then apply it to \`origin/${base}...HEAD\`. If the skill is unavailable, independently review correctness, API contracts, error handling, concurrency, security, regressions, and test coverage; require severity, file:line, concrete evidence, and an explicit verdict. If the codex provider is unavailable or spawn errors, mark this section skipped with the exact safe error and continue.

### D. OCR

Only if \`ocr --version\` succeeded in Step 1, launch the fourth reviewer. It must run exactly:
\`ocr review --audience agent --from origin/${base} --to HEAD\`
It must classify findings as High/Medium/Low, discard low-confidence noise, and return file:line evidence. It must never install or reconfigure anything and must not modify files. If OCR was unavailable, skip it with this install hint: \`npm i -g @alibaba-group/open-code-review\`.

## Step 3 — collect

Wait for all four reviewer results. A failed or skipped reviewer is a failed/skipped section, not a reason to abort. Keep each report intact enough to preserve its evidence, verdict, and coverage limitations.

## Step 4 — synthesize and post

Write the final PR review body with the individual reviewer sections FIRST:
1. Runtime bug hunt
2. Thermo-nuclear quality
3. Codex review
4. OCR

Then add this highlighted callout as the final synthesis:

---
## 🎯 CROSS-CUTTING SUMMARY

> ### ⚡ Verdict: SHIP / FIX-FIRST / NEEDS-REWORK
>
> **🔴 Flagged by 2+ reviewers (highest confidence)** — list shared root causes first with reviewer attribution.
>
> **Top finding per reviewer** — one top finding for bug hunter, thermo-nuclear, Codex, and OCR (or SKIPPED/FAILED).
>
> **⚠️ Coverage caveats** — explicitly list skipped/failed reviewers and any uncommitted or otherwise uncovered changes.

Immediately below it, add \`### 📋 Detailed findings\`: dedupe by root cause, not wording; severity-order findings as 🔴 Blocker, 🟠 Major, 🟡 Minor, 🔵 Nit; order ties by number of reviewers. Use stable numbering. Include an index table with number, severity, finding, location, and flagged-by attribution. Add detail blocks only for blockers and majors, with location, what breaks, evidence pointer, and a suggested fix described only (never applied). Do not invent findings: every item must trace to a reviewer section. Minors and nits remain one-line table entries. If there are no actionable findings, say so instead of padding the report.

Finally post the review with:
\`gh pr review ${pr.number} --repo ${pr.repo}\`
Use \`--approve\` only for verdict SHIP. Use \`--comment\` for FIX-FIRST or NEEDS-REWORK. NEVER use \`--request-changes\` unless there is a concrete high-confidence blocker finding that was either reproduced by the bug hunter or flagged by at least two reviewers. The full report, including all reviewer sections and the final synthesis, must also remain in this session as the final message. Do not apply fixes afterward. This session is review-only.`
}

export async function startPrAction(action:"resolve"|"review",pr:PrSummary):Promise<PrActionResponse>{ const cfg=getGithubConfig(); const c=await checkout(pr.repo.split("/")[1]!,pr.repo.split("/")[0]!,pr.number,pr.headRef,cfg?.token); const id=randomUUID(); Store.createSession(id, action==="resolve"?`Resolve PR comments: ${pr.repo.split("/")[1]}#${pr.number}`:`Review PR: ${pr.repo.split("/")[1]}#${pr.number}`,c.path); const now=Date.now(); const goal:Goal={sessionId:id,objective:action === "review" ? buildReviewObjective(pr as ReviewPr, c.path) : objective(action,pr,c.path),status:"active",mode:"direct",createdAt:now,updatedAt:now,turns:0,maxTurns:12}; Store.putGoal(goal); emitToSession(id,{type:"goal.update",sessionId:id,goal:toSnapshot(goal),message:`◎ PR ${action} started — ${pr.repo}#${pr.number}`}); deliverToSession(id,{prompt:goalKickoffPrompt(goal),shown:goal.objective,from:"PR Reviews"}); linkPr(pr.repo,pr.number,{sessionId:id,clonePath:c.path,chunkyManaged:c.managed}); return {sessionId:id,repoId:repoId(c.path)} }
export interface ReapCandidate { key: string; link: PrLink }
export function reapDecisions(entries: ReapCandidate[], open: Set<string>): ReapCandidate[] {
  return entries.filter(({key, link}) => !open.has(key) && link.chunkyManaged)
}
export function normalizeRemote(value: string): string | null {
  const v=value.trim().replace(/\.git$/, "")
  const m=v.match(/(?:github\.com[/:])([^/]+)\/([^/]+)$/i)
  return m ? `${m[1].toLowerCase()}/${m[2].toLowerCase()}` : null
}
export function remoteMatches(value: string, repo: string): boolean { return normalizeRemote(value) === repo.toLowerCase() }
export function cleanupKind(link: PrLink): "worktree" | "clone" | "none" {
  if (!link.chunkyManaged) return "none"
  return link.clonePath?.includes(`${join("github", "worktrees")}${"/"}`) ? "worktree" : "clone"
}
export function cleanupManagedLink(repo:string,number:number,link:PrLink, removeRepoFn: (id:string)=>unknown = () => undefined):void {
  if(!link.chunkyManaged || !link.clonePath) return
  if (cleanupKind(link) === "worktree") { deletePrLink(repo,number); return }
  try { rmSync(link.clonePath,{recursive:true,force:true}); removeRepoFn(repoId(link.clonePath)) } catch {}
  deletePrLink(repo,number)
}
