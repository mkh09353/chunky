import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect } from "bun:test"

const dir = await mkdtemp(join(tmpdir(), "chunky-store-smoke-"))
process.env.CHUNKY_DB = join(dir, "smoke.db")
const { Store } = await import("./store.ts")

const selection = { provider: "openai", model: "gpt-4o", effort: "low" } as const
const unpriced = { provider: "mystery", model: "not-in-catalog", effort: undefined } as const
const pricedId = "smoke-priced"
const unknownId = "smoke-unknown"

Store.createDelegation({ id: pricedId, sessionId: "smoke-session", kind: "sidekick", seat: "backend", provider: selection.provider, model: selection.model, effort: selection.effort, briefSnippet: "priced brief" })
Store.createDelegation({ id: unknownId, sessionId: "smoke-session", kind: "child", seat: "frontend", provider: unpriced.provider, model: unpriced.model, briefSnippet: "unknown brief" })

// Usage inside the active brief window is attributed; usage outside it remains
// durable but deliberately has no delegation id.
Store.logUsage({ sessionId: "smoke-session", threadId: "thread-sidekick", role: "sidekick", provider: selection.provider, model: selection.model, effort: selection.effort, delegationId: pricedId, inputTokens: 1_000, outputTokens: 200, reasoningTokens: 30, cacheReadTokens: 100, cacheWriteTokens: 50 })
Store.logUsage({ sessionId: "smoke-session", threadId: "thread-sidekick", role: "sidekick", provider: selection.provider, model: selection.model, effort: selection.effort, delegationId: null, inputTokens: 100, outputTokens: 20 })
Store.logUsage({ sessionId: "smoke-session", threadId: "thread-child", role: "child", provider: unpriced.provider, model: unpriced.model, delegationId: unknownId, inputTokens: 50, outputTokens: 10 })
Store.completeDelegation(pricedId, true)
await Bun.sleep(3)
Store.completeDelegation(unknownId, true)

// Exercise explicit, last, and last:<seat> resolution. The latter two both
// resolve the most recently completed matching delegation.
if (Store.resolveDelegation("smoke-session", pricedId) !== pricedId) throw new Error("explicit resolver failed")
Store.rateDelegation(pricedId, 8, false, "clear and correct", selection)
const last = Store.resolveDelegation("smoke-session", "last")
if (last !== unknownId) throw new Error(`last resolver failed: ${last}`)
Store.rateDelegation(last!, 6, true, "needed a follow-up", selection)
const lastBackend = Store.resolveDelegation("smoke-session", "last:backend")
if (lastBackend !== pricedId) throw new Error(`last:seat resolver failed: ${lastBackend}`)

const usage = Store.usageRows("smoke-session")
expect(usage).toEqual(expect.arrayContaining([
  expect.objectContaining({ role: "sidekick", provider: "openai", model: "gpt-4o", inputTokens: 1_100, outputTokens: 220, requests: 2 }),
  expect.objectContaining({ role: "child", provider: "mystery", model: "not-in-catalog", inputTokens: 50, cost: null, requests: 1 }),
]))
const priced = usage.find((row) => row.model === "gpt-4o")!
expect(priced.cost).toBeCloseTo((1000 * 2.5 + 200 * 10 + 100 * 1.25 + 50 * 1.25) / 1_000_000)

const scoreboard = Store.scoreboardRows("smoke-session")
expect(scoreboard).toEqual(expect.arrayContaining([
  expect.objectContaining({ provider: "openai", model: "gpt-4o", kind: "sidekick", samples: 1, avgRating: 8, ratedCount: 1, totalTokens: 1200 }),
  expect.objectContaining({ provider: "mystery", model: "not-in-catalog", kind: "child", samples: 1, avgRating: 6, ratedCount: 1, totalCost: null, totalTokens: 60 }),
]))
console.log("store smoke: delegation lifecycle, usage attribution, pricing, scoreboard, and rating resolvers passed")
