import { expect } from "bun:test"
import { Store } from "./store.ts"

const sessionId = "usage-breakdown-score-seat-session"
const day = (date: string, hour = 12) => {
  const [year, month, dateOfMonth] = date.split("-").map(Number)
  return new Date(year!, month! - 1, dateOfMonth!, hour).getTime()
}
const from = "2026-07-01", to = "2026-07-03"
const judge = { provider: "codex", model: "gpt-4o" } as const

Store.createSession(sessionId)

const unnamed = "score-unnamed"
const literalDefault = "score-literal-default"
const frontend = "score-frontend"
const websearch = "score-websearch"
Store.createDelegation({ id: unnamed, sessionId, kind: "sidekick", provider: "codex", model: "gpt-4o", briefSnippet: "unnamed" })
Store.createDelegation({ id: literalDefault, sessionId, kind: "sidekick", seat: "default", provider: "codex", model: "gpt-4o", briefSnippet: "literal default" })
Store.createDelegation({ id: frontend, sessionId, kind: "sidekick", seat: "frontend", provider: "codex", model: "gpt-4o", briefSnippet: "frontend" })
Store.createDelegation({ id: websearch, sessionId, kind: "sidekick", seat: "websearch", provider: "codex", model: "gpt-4o", briefSnippet: "websearch" })

Store.rateDelegation(unnamed, 8, false, "good unnamed", judge)
Store.rateDelegation(literalDefault, 6, true, "reworked default", judge)
Store.rateDelegation(frontend, 9, false, "good frontend", judge)
Store.rateDelegation(websearch, 4, true, "reworked websearch", judge)

// EXISTS-in-range is what puts a delegation on the breakdown.
Store.logUsage({ sessionId, role: "sidekick", provider: "codex", model: "gpt-4o", delegationId: unnamed, inputTokens: 100, ts: day(from, 12) })
Store.logUsage({ sessionId, role: "sidekick", provider: "codex", model: "gpt-4o", delegationId: literalDefault, inputTokens: 100, ts: day(from, 13) })
Store.logUsage({ sessionId, role: "sidekick", provider: "codex", model: "gpt-4o", delegationId: frontend, inputTokens: 100, ts: day(from, 14) })
Store.logUsage({ sessionId, role: "sidekick", provider: "codex", model: "gpt-4o", delegationId: websearch, inputTokens: 100, ts: day(from, 15) })

const breakdown = Store.usageBreakdown({ scope: "session", sessionId }, from, to, () => "subscription")
const row = breakdown.rows.find((entry) => entry.provider === "codex" && entry.model === "gpt-4o")
if (!row) throw new Error("missing gpt-4o breakdown row")

// Model-level score is unchanged: all four ratings still fold into one row.
expect(row.avgRating).toBe(6.75)
expect(row.ratedCount).toBe(4)
expect(row.reworkRate).toBe(0.5)
expect(row.scoreBySeat).toEqual([
  { kind: "sidekick", seat: null, avgRating: 7, ratedCount: 2, reworkRate: 0.5, samples: 2 },
  { kind: "sidekick", seat: "frontend", avgRating: 9, ratedCount: 1, reworkRate: 0, samples: 1 },
  { kind: "sidekick", seat: "websearch", avgRating: 4, ratedCount: 1, reworkRate: 1, samples: 1 },
])

console.log(JSON.stringify({
  provider: row.provider,
  model: row.model,
  avgRating: row.avgRating,
  ratedCount: row.ratedCount,
  reworkRate: row.reworkRate,
  scoreBySeat: row.scoreBySeat,
}))
console.log("usage breakdown scoreBySeat: default collapsed, named seats split, model score unchanged")
