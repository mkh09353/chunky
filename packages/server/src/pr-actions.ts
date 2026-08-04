import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import { join, basename } from "node:path"
import type { PrActionRequest, PrActionResponse, PrSummary } from "@chunky/protocol"
import { stateDir, listRepos, addRepo, repoId } from "./repos.ts"
import { Store } from "./store.ts"
import { deliverToSession } from "./session-bus.ts"
import { emitToSession } from "./session-bus.ts"
import { goalKickoffPrompt, toSnapshot, type Goal } from "./goal.ts"
import { getGithubConfig } from "./settings.ts"

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
function objective(action:"resolve"|"review", pr:PrSummary, workdir:string):string { if(action==="resolve") return `Resolve every unresolved review thread on ${pr.repo}#${pr.number}. PR: ${pr.url}. Branch: ${pr.headRef}. Work in ${workdir}. Fetch the unresolved review threads with gh api graphql, address each comment with tested code changes, commit and push to the PR branch, reply to each thread explaining the fix and resolve it with the resolveReviewThread GraphQL mutation, then re-request review from the reviewers who left comments using gh api. Verify the changes and report the commit and review actions.`; return `Review ${pr.repo}#${pr.number}. PR: ${pr.url}. Branch: ${pr.headRef}. Work in ${workdir}. Study the diff against the base with gh pr diff, review correctness, bugs, regressions, and style, then leave review comments and a verdict with gh pr review (comment or approve; never request changes without concrete findings). Verify the review was submitted.` }
export async function startPrAction(action:"resolve"|"review",pr:PrSummary):Promise<PrActionResponse>{ const cfg=getGithubConfig(); const c=await checkout(pr.repo.split("/")[1]!,pr.repo.split("/")[0]!,pr.number,pr.headRef,cfg?.token); const id=randomUUID(); Store.createSession(id, action==="resolve"?`Resolve PR comments: ${pr.repo.split("/")[1]}#${pr.number}`:`Review PR: ${pr.repo.split("/")[1]}#${pr.number}`,c.path); const now=Date.now(); const goal:Goal={sessionId:id,objective:objective(action,pr,c.path),status:"active",mode:"direct",createdAt:now,updatedAt:now,turns:0,maxTurns:12}; Store.putGoal(goal); emitToSession(id,{type:"goal.update",sessionId:id,goal:toSnapshot(goal),message:`◎ PR ${action} started — ${pr.repo}#${pr.number}`}); deliverToSession(id,{prompt:goalKickoffPrompt(goal),shown:goal.objective,from:"PR Reviews"}); linkPr(pr.repo,pr.number,{sessionId:id,clonePath:c.path,chunkyManaged:c.managed}); return {sessionId:id,repoId:repoId(c.path)} }
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
