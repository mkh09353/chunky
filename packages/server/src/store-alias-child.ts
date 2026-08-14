import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect } from "bun:test"

const dir = await mkdtemp(join(tmpdir(), "chunky-store-alias-"))
process.env.CHUNKY_DB = join(dir, "alias.db")
// Pin an empty models.dev cache so alias resolution uses the built-in family fallback.
process.env.CHUNKY_MODELS_CACHE = join(dir, "missing-models.json")

const { openSqlite } = await import("./sqlite.ts")
const seed = openSqlite(process.env.CHUNKY_DB)
seed.exec(`
  CREATE TABLE IF NOT EXISTS delegations (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, kind TEXT NOT NULL, seat TEXT,
    provider TEXT NOT NULL, model TEXT NOT NULL, effort TEXT, brief_snippet TEXT NOT NULL,
    started_at INTEGER NOT NULL, completed_at INTEGER, ok INTEGER
  );
  CREATE TABLE IF NOT EXISTS usage_log (
    id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, thread_id TEXT, role TEXT NOT NULL,
    provider TEXT NOT NULL, model TEXT NOT NULL, effort TEXT, delegation_id TEXT, ts INTEGER NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
    reasoning_tokens INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0, cost REAL
  );
`)
const now = Date.now()
seed.query("INSERT INTO delegations (id,session_id,kind,seat,provider,model,effort,brief_snippet,started_at) VALUES (?,?,?,?,?,?,?,?,?)")
  .run("legacy-opus-1m", "legacy-session", "sidekick", "frontend", "anthropic", "opus[1m]", "high", "legacy alias", now)
seed.query("INSERT INTO delegations (id,session_id,kind,seat,provider,model,effort,brief_snippet,started_at) VALUES (?,?,?,?,?,?,?,?,?)")
  .run("legacy-opus-older", "legacy-session", "sidekick", "frontend", "anthropic", "opus[1m]", "high", "older usage wins", now)
seed.query("INSERT INTO usage_log (session_id,role,provider,model,delegation_id,ts,input_tokens,output_tokens) VALUES (?,?,?,?,?,?,?,?)")
  .run("legacy-session", "sidekick", "anthropic", "claude-opus-4-8[1m]", "legacy-opus-older", now, 10, 2)
seed.query("INSERT INTO usage_log (session_id,role,provider,model,delegation_id,ts,input_tokens,output_tokens) VALUES (?,?,?,?,?,?,?,?)")
  .run("legacy-session", "sidekick", "anthropic", "unknown", "legacy-opus-older", now + 1, 10, 2)
seed.query("INSERT INTO delegations (id,session_id,kind,seat,provider,model,effort,brief_snippet,started_at) VALUES (?,?,?,?,?,?,?,?,?)")
  .run("legacy-opus", "legacy-session", "sidekick", null, "anthropic", "opus", null, "legacy bare alias", now)
seed.query("INSERT INTO delegations (id,session_id,kind,seat,provider,model,effort,brief_snippet,started_at) VALUES (?,?,?,?,?,?,?,?,?)")
  .run("legacy-sonnet-1m", "legacy-session", "child", null, "anthropic", "sonnet[1m]", null, "legacy sonnet", now)
seed.query("INSERT INTO delegations (id,session_id,kind,seat,provider,model,effort,brief_snippet,started_at) VALUES (?,?,?,?,?,?,?,?,?)")
  .run("already-canonical", "legacy-session", "sidekick", null, "anthropic", "claude-opus-5[1m]", null, "already canonical", now)
seed.query("INSERT INTO delegations (id,session_id,kind,seat,provider,model,effort,brief_snippet,started_at) VALUES (?,?,?,?,?,?,?,?,?)")
  .run("unknown-model", "legacy-session", "child", null, "mystery", "not-in-catalog", null, "unknown", now)

const { Store } = await import("./store.ts")
const { resolveCatalogModelId } = await import("./providers/models-catalog.ts")

const migrated = Object.fromEntries(
  (seed.query("SELECT id, model FROM delegations").all() as Array<{ id: string; model: string }>).map((row) => [row.id, row.model]),
)
expect(migrated["legacy-opus-1m"]).toBe("claude-opus-5[1m]")
expect(migrated["legacy-opus-older"]).toBe("claude-opus-4-8[1m]")
expect(migrated["legacy-opus"]).toBe("claude-opus-5")
expect(migrated["legacy-sonnet-1m"]).toBe("claude-sonnet-5[1m]")
expect(migrated["already-canonical"]).toBe("claude-opus-5[1m]")
expect(migrated["unknown-model"]).toBe("not-in-catalog")
for (const [id, model] of Object.entries(migrated)) {
  if (id === "legacy-opus-older") continue
  expect(resolveCatalogModelId(model)).toBe(model)
}

const sessionId = "alias-join-session"
const delegationId = "alias-join"
const day = (date: string, hour = 12) => {
  const [year, month, dateOfMonth] = date.split("-").map(Number)
  return new Date(year!, month! - 1, dateOfMonth!, hour).getTime()
}
const from = "2026-07-01", to = "2026-07-01"
Store.createSession(sessionId)
Store.createDelegation({
  id: delegationId,
  sessionId,
  kind: "sidekick",
  seat: "frontend",
  provider: "anthropic",
  model: "opus[1m]",
  effort: "high",
  briefSnippet: "alias insert",
})
const stored = seed.query("SELECT model FROM delegations WHERE id=?").get(delegationId) as { model: string }
expect(stored.model).toBe("claude-opus-5[1m]")
Store.rateDelegation(delegationId, 8, false, "clear", { provider: "anthropic", model: "claude-opus-5[1m]" })
Store.logUsage({
  sessionId,
  role: "sidekick",
  provider: "anthropic",
  model: "claude-opus-5[1m]",
  delegationId,
  inputTokens: 100,
  outputTokens: 20,
  ts: day(from),
})
const breakdown = Store.usageBreakdown({ scope: "session", sessionId }, from, to, () => "subscription")
const row = breakdown.rows.find((entry) => entry.provider === "anthropic" && entry.model === "claude-opus-5[1m]")
expect(row).toMatchObject({ avgRating: 8, ratedCount: 1 })
console.log("store alias: insert resolves, usageBreakdown joins rating, usage-derived migration prefers historical id")
