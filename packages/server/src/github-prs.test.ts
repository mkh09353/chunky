import { beforeEach, expect, test } from "bun:test"
import { mapPullRequest, resetPrReviewsForTest, setGithubDepsForTest, fetchPrReviews, pollPrReviews, PR_QUERY } from "./github-prs.ts"
import { setGithubConfig } from "./settings.ts"
const node=(ci:any,review:any,threads:any[]=[]):any=>({id:"id",number:1,title:"T",url:"u",repository:{nameWithOwner:"o/r"},headRefName:"b",author:{login:"a"},isDraft:false,labels:{nodes:[{name:"x"}]},createdAt:"2024-01-01",updatedAt:"2024-01-02",reviewDecision:review,commits:{nodes:[{commit:{statusCheckRollup:ci===null?null:{state:ci}}}]},reviewThreads:{nodes:threads.map(isResolved=>({isResolved}))}})
beforeEach(()=>{ resetPrReviewsForTest(); process.env.CHUNKY_SETTINGS=`/tmp/chunky-pr-test-${process.pid}.json`; setGithubConfig({org:"o",token:"tok"}) })
test("maps CI, review, labels, and unresolved threads",()=>{ expect(mapPullRequest(node("SUCCESS","APPROVED",[false,true])).ciStatus).toBe("passing"); expect(mapPullRequest(node("FAILURE","CHANGES_REQUESTED")).ciStatus).toBe("failing"); expect(mapPullRequest(node("ERROR","REVIEW_REQUIRED")).ciStatus).toBe("failing"); expect(mapPullRequest(node("PENDING",null)).ciStatus).toBe("pending"); expect(mapPullRequest(node("EXPECTED",null)).ciStatus).toBe("pending"); expect(mapPullRequest(node(null,null)).ciStatus).toBe("none"); expect(mapPullRequest(node("SUCCESS","APPROVED",[false,true,false])).unresolvedThreads).toBe(2) })
test("query uses PullRequest fragment and schema fields",()=>{ expect(PR_QUERY).toContain("... on PullRequest"); expect(PR_QUERY).toContain("statusCheckRollup{state}"); expect(PR_QUERY).toContain("reviewThreads(first:100)") })
test("queue sorted oldest first and orgs fetched",async()=>{let calls=0; setGithubDepsForTest({fetch:async(_i,init)=>{calls++; const body=JSON.parse(String(init?.body)); if(body.query.includes("viewer")) return Response.json({data:{viewer:{organizations:{nodes:[{login:"o"}]}}}}); const q=body.variables.q; return Response.json({data:{search:{nodes:[node("SUCCESS",null)]}}})}}); const state=await fetchPrReviews(); expect(state.reviewQueue[0]?.createdAt).toBe("2024-01-01"); expect(calls).toBe(3) })
test("poll error is returned and concurrent polls share one request",async()=>{let resolve!:()=>void; let calls=0; setGithubDepsForTest({fetch:async()=>{calls++; await new Promise<void>(r=>resolve=r); return Response.json({errors:[{}]})}}); const a=pollPrReviews(), b=pollPrReviews(); expect(a).toBe(b); await new Promise(r=>setTimeout(r,0)); resolve(); const state=await a; expect(state.error).toBeDefined(); expect(calls).toBe(3) })
test("settings token wins and 401 causes token re-resolution", async () => {
  let tokens = 0
  let requests = 0
  setGithubDepsForTest({
    spawnToken: async () => { tokens++; return "gh-token" },
    fetch: async () => {
      requests++
      if (requests === 1) return new Response("", { status: 401 })
      return Response.json({ data: { search: { nodes: [] }, viewer: { organizations: { nodes: [] } } } })
    },
  })
  await fetchPrReviews()
  expect(tokens).toBe(0)
  expect(requests).toBe(4)
  setGithubConfig({ token: undefined })
  resetPrReviewsForTest()
  setGithubDepsForTest({ spawnToken: async () => { tokens++; return "gh-token" }, fetch: async () => Response.json({ data: { search: { nodes: [] }, viewer: { organizations: { nodes: [] } } } }) })
  await fetchPrReviews()
  expect(tokens).toBeGreaterThan(0)
})
