import type { PrReviewsState, PrSummary } from "@chunky/protocol"
import { getGithubConfig } from "./settings.ts"

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
export interface GithubDeps { fetch?: FetchLike; spawnToken?: () => Promise<string | null> }
const endpoint = "https://api.github.com/graphql"
export const PR_QUERY = `query($q:String!){search(query:$q,type:ISSUE,first:30){nodes{... on PullRequest{id number title url repository{nameWithOwner} baseRefName headRefName author{login} isDraft labels(first:20){nodes{name}} createdAt updatedAt reviewDecision commits(last:1){nodes{commit{statusCheckRollup{state}}}} reviewThreads(first:100){nodes{isResolved}}}}}}}`
export const VIEWER_ORGS_QUERY = `query{viewer{organizations(first:20){nodes{login}}}}`
let deps: GithubDeps = {}
let cachedToken: string | null | undefined
let latest: PrReviewsState | null = null
let viewerOrgs: string[] = []
let activePoll: Promise<PrReviewsState> | undefined
let timer: ReturnType<typeof setTimeout> | undefined

export function setGithubDepsForTest(next: GithubDeps): void { deps = next; cachedToken = undefined }
export function resetGithubTokenCache(): void { cachedToken = undefined }
async function ghToken(): Promise<string | null> {
  if (cachedToken !== undefined) return cachedToken
  if (deps.spawnToken) return cachedToken = await deps.spawnToken()
  try {
    const p = Bun.spawn(["gh", "auth", "token"], { stdout: "pipe", stderr: "pipe" })
    const value = (await new Response(p.stdout).text()).trim()
    await p.exited
    return cachedToken = value || null
  } catch { return cachedToken = null }
}
export async function resolveGithubToken(): Promise<string | null> {
  const configured = getGithubConfig()?.token?.trim()
  return configured || await ghToken()
}
function ciStatus(value: unknown): PrSummary["ciStatus"] { switch (value) { case "SUCCESS": return "passing"; case "FAILURE": case "ERROR": return "failing"; case "PENDING": case "EXPECTED": return "pending"; default: return "none" } }
function reviewDecision(value: unknown): PrSummary["reviewDecision"] { switch (value) { case "APPROVED": return "approved"; case "CHANGES_REQUESTED": return "changes_requested"; case "REVIEW_REQUIRED": return "review_required"; default: return "none" } }
export function mapPullRequest(n: any): PrSummary {
  const state = n.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state
  return { id:n.id, number:n.number, title:n.title, url:n.url, repo:n.repository.nameWithOwner, headRef:n.headRefName, ...(n.baseRefName ? { baseRefName:n.baseRefName } : {}), author:n.author?.login ?? "unknown", isDraft:!!n.isDraft, ciStatus:ciStatus(state), reviewDecision:reviewDecision(n.reviewDecision), unresolvedThreads:(n.reviewThreads?.nodes ?? []).filter((x:any) => x.isResolved === false).length, labels:(n.labels?.nodes ?? []).map((x:any) => x.name), createdAt:n.createdAt, updatedAt:n.updatedAt }
}
async function graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const t = await resolveGithubToken()
  if (!t) throw new Error("GitHub token unavailable")
  const request = (auth: string) => (deps.fetch ?? fetch)(endpoint, { method:"POST", headers:{ authorization:`bearer ${auth}`, accept:"application/json", "content-type":"application/json" }, body:JSON.stringify({ query, variables }) })
  let response = await request(t)
  if (response.status === 401) { cachedToken = undefined; const refreshed = await resolveGithubToken(); if (!refreshed) throw new Error("GitHub authentication failed"); response = await request(refreshed); if (response.status === 401) throw new Error("GitHub authentication failed") }
  if (!response.ok) throw new Error(`GitHub request failed (${response.status})`)
  const body = await response.json() as any
  if (body.errors?.length) throw new Error("GitHub GraphQL request failed")
  return body.data as T
}
export async function fetchPrReviews(): Promise<PrReviewsState> {
  const cfg = getGithubConfig() ?? {}, org = cfg.org?.trim()
  const configured = !!(await resolveGithubToken())
  if (!org) { const result: PrReviewsState = { org:null, configured, mine:[], reviewQueue:[], fetchedAt:null }; latest=result; return result }
  const label = (cfg.readyLabel?.trim() || "ready-to-review").replaceAll('"', "")
  const [mine, queue, orgData] = await Promise.all([
    graphql<any>(PR_QUERY, { q:`is:pr is:open org:${org} author:@me` }),
    graphql<any>(PR_QUERY, { q:`is:pr is:open org:${org} label:"${label}" -author:@me` }),
    graphql<any>(VIEWER_ORGS_QUERY),
  ])
  viewerOrgs = (orgData.viewer?.organizations?.nodes ?? []).map((x:any) => x.login)
  const result: PrReviewsState = { org, configured:true, mine:(mine.search.nodes ?? []).map(mapPullRequest), reviewQueue:(queue.search.nodes ?? []).map(mapPullRequest).sort((a:PrSummary,b:PrSummary) => a.createdAt.localeCompare(b.createdAt)), fetchedAt:Date.now() }
  latest=result
  return result
}
export function currentPrReviews(): PrReviewsState | null { return latest }
export function currentGithubOrgs(): string[] { return [...viewerOrgs] }
export function pollPrReviews(_force=false): Promise<PrReviewsState> {
  if (activePoll) return activePoll
  activePoll = fetchPrReviews().catch((error: unknown) => { const result: PrReviewsState = { ...(latest ?? { org:getGithubConfig()?.org ?? null, configured:true, mine:[], reviewQueue:[], fetchedAt:null }), error:error instanceof Error ? error.message : "GitHub poll failed" }; latest=result; return result }).finally(() => { activePoll=undefined })
  return activePoll
}
export function startPrReviewsPoller(): () => void {
  if (timer) clearTimeout(timer)
  const tick = async () => { await pollPrReviews(); timer=setTimeout(tick, 180000); timer.unref?.() }
  void tick()
  return () => { if (timer) clearTimeout(timer); timer=undefined }
}
export function resetPrReviewsForTest(): void { if(timer)clearTimeout(timer); timer=undefined; activePoll=undefined; latest=null; viewerOrgs=[]; cachedToken=undefined; deps={} }
