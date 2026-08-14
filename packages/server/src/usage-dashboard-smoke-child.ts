import { expect } from "bun:test"
import { Store } from "./store.ts"

const sessionId = "usage-dashboard-session"
const day = (date: string, hour = 12) => {
  const [year, month, dateOfMonth] = date.split("-").map(Number)
  return new Date(year!, month! - 1, dateOfMonth!, hour).getTime()
}
const from = "2026-07-01", to = "2026-07-03"
Store.createSession(sessionId)
Store.logUsage({ sessionId, role: "lead", provider: "codex", model: "gpt-4o", inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 500_000, ts: day(from) })
Store.logUsage({ sessionId, role: "lead", provider: "mystery", model: "not-priced", inputTokens: 50, outputTokens: 10, ts: day(to) })

const billing = (provider: string) => provider === "codex" ? "subscription" : null
const series = Store.usageSeries({ scope: "session", sessionId }, from, to, billing)
expect(series.buckets).toHaveLength(3)
// Static MODEL_PRICING["gpt-4o"] = {input:2.5, output:10, cacheRead:1.25}:
// (1e6*2.5 + 1e5*10 + 5e5*1.25) / 1e6 = 4.125. cacheSavings = 5e5*(2.5-1.25)/1e6 = 0.625.
expect(series.buckets[0]).toMatchObject({ date: from, requests: 1, inputTokens: 1_000_000, estimatedApiCost: 4.125, unpricedRequests: 0 })
expect(series.buckets[0]!.byProvider).toEqual([{ provider: "codex", billing: "subscription", estimatedApiCost: 4.125, tokens: 1_600_000 }])
expect(series.buckets[1]).toMatchObject({ date: "2026-07-02", requests: 0, estimatedApiCost: 0, byProvider: [] })
expect(series.buckets[2]).toMatchObject({ date: to, requests: 1, estimatedApiCost: 0, unpricedRequests: 1 })

const pricedDelegation = "rated-gpt"
const secondDelegation = "rated-gpt-2"
Store.createDelegation({ id: pricedDelegation, sessionId, kind: "sidekick", provider: "codex", model: "gpt-4o", briefSnippet: "one" })
Store.createDelegation({ id: secondDelegation, sessionId, kind: "child", provider: "codex", model: "gpt-4o", briefSnippet: "two" })
Store.rateDelegation(pricedDelegation, 8, false, "good", { provider: "codex", model: "gpt-4o" })
Store.rateDelegation(secondDelegation, 4, true, "reworked", { provider: "codex", model: "gpt-4o" })
// Two usage records on one delegation previously inflated samples/ratedCount.
Store.logUsage({ sessionId, role: "sidekick", provider: "codex", model: "gpt-4o", delegationId: pricedDelegation, inputTokens: 100, ts: day(from, 13) })
Store.logUsage({ sessionId, role: "sidekick", provider: "codex", model: "gpt-4o", delegationId: pricedDelegation, inputTokens: 200, ts: day(from, 14) })
Store.logUsage({ sessionId, role: "child", provider: "codex", model: "gpt-4o", delegationId: secondDelegation, inputTokens: 300, ts: day(from, 15) })

const breakdown = Store.usageBreakdown({ scope: "session", sessionId }, from, to, billing)
const codex = breakdown.rows.find((row) => row.provider === "codex" && row.model === "gpt-4o")!
expect(codex).toMatchObject({ requests: 4, priced: true, avgRating: 6, ratedCount: 2, reworkRate: 0.5 })
expect(breakdown.rows.find((row) => row.provider === "mystery")).toMatchObject({ priced: false, estimatedApiCost: 0 })
expect(breakdown.totals.pricedShare).toBe(4 / 5)
expect(breakdown.totals.cacheSavings).toBe(0.625)
expect(breakdown.providers[0]).toMatchObject({ provider: "codex", billing: "subscription" })

const scoreboard = Store.scoreboardRows(sessionId)
expect(scoreboard.reduce((sum, row) => sum + row.samples, 0)).toBe(2)
expect(scoreboard.reduce((sum, row) => sum + row.ratedCount, 0)).toBe(2)
expect(scoreboard.reduce((sum, row) => sum + row.totalTokens, 0)).toBe(600)
console.log("usage dashboard smoke: bucketing, zero-fill, what-if pricing, unpriced share, ratings, and scoreboard counts passed")
