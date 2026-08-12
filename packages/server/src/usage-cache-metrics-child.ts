import { expect } from "bun:test"
import { Database } from "bun:sqlite"

const dbPath = process.env.CHUNKY_DB!
const mode = process.env.CACHE_METRICS_MODE

if (mode === "migration") {
  const old = new Database(dbPath)
  old.exec(`CREATE TABLE usage_log (
    id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, thread_id TEXT, role TEXT NOT NULL,
    provider TEXT NOT NULL, model TEXT NOT NULL, effort TEXT, delegation_id TEXT, ts INTEGER NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
    reasoning_tokens INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0, cost REAL
  )`)
  old.query(`INSERT INTO usage_log (session_id,role,provider,model,ts,input_tokens,cache_read_tokens,cache_write_tokens)
    VALUES (?,?,?,?,?,?,?,?)`).run("old-session", "lead", "anthropic", "claude-old", 1, 10, 20, 30)
  old.close()

  const { Store } = await import("./store.ts")
  const migrated = new Database(dbPath)
  const columns = (migrated.query("PRAGMA table_info(usage_log)").all() as Array<{ name: string }>).map((column) => column.name)
  for (const column of ["cache_cold", "cache_cold_reason", "idle_ms", "wake_source", "detached_spawn_id", "turn_index"]) expect(columns).toContain(column)
  expect(migrated.query("SELECT cache_cold,cache_cold_reason,idle_ms,wake_source,detached_spawn_id,turn_index FROM usage_log WHERE session_id=?").get("old-session"))
    .toEqual({ cache_cold: null, cache_cold_reason: null, idle_ms: null, wake_source: null, detached_spawn_id: null, turn_index: null })
  expect(Store.sessionCacheMetrics("old-session")).toMatchObject({ turns: 1, promptTokens: 60, unclassifiedTurns: 1 })
  migrated.close()
  console.log("cache metrics migration: ok")
} else {
  const { Store } = await import("./store.ts")
  const sessionId = "cache-metrics-session"
  Store.createSession(sessionId)
  Store.logUsage({ sessionId, role: "lead", provider: "anthropic", model: "claude", inputTokens: 10, cacheReadTokens: 90, cacheWriteTokens: 0, cacheCold: false, idleMs: 1_000, turnIndex: 1 })
  Store.logUsage({ sessionId, role: "lead", provider: "anthropic", model: "claude", inputTokens: 30, cacheReadTokens: 0, cacheWriteTokens: 70, cacheCold: true, cacheColdReason: "idle", idleMs: 300_001, wakeSource: "sidekick", detachedSpawnId: "spawn-1", turnIndex: 2 })
  Store.logUsage({ sessionId, role: "lead", provider: "anthropic", model: "claude", cacheCold: true, cacheColdReason: "model-switch", wakeSource: "spawn_thread", detachedSpawnId: "spawn-2", turnIndex: 3 })
  Store.logUsage({ sessionId, role: "lead", provider: "anthropic", model: "claude", inputTokens: 20, cacheReadTokens: 20, cacheWriteTokens: 10 })
  Store.logUsage({ sessionId, role: "child", provider: "anthropic", model: "claude", inputTokens: 999, cacheReadTokens: 999, cacheCold: true, wakeSource: "sidekick" })

  const db = new Database(dbPath)
  expect(db.query(`SELECT cache_cold cacheCold,cache_cold_reason cacheColdReason,wake_source wakeSource,
    detached_spawn_id detachedSpawnId,turn_index turnIndex,idle_ms idleMs FROM usage_log WHERE session_id=? AND turn_index=2`).get(sessionId)).toEqual({
    cacheCold: 1, cacheColdReason: "idle", wakeSource: "sidekick", detachedSpawnId: "spawn-1", turnIndex: 2, idleMs: 300_001,
  })
  db.close()
  expect(Store.sessionCacheMetrics(sessionId)).toEqual({
    turns: 4, inputTokens: 60, cacheReadTokens: 110, cacheWriteTokens: 80, promptTokens: 250,
    coldTurns: 2, unclassifiedTurns: 1, detachedWakeTurns: 2, coldDetachedWakeTurns: 2,
    coldDetachedWakeInputTokens: 30, coldDetachedWakeCacheWriteTokens: 70, cacheHitRate: 110 / 250,
  })
  const zero = "cache-metrics-zero"
  Store.createSession(zero)
  Store.logUsage({ sessionId: zero, role: "lead", provider: "anthropic", model: "claude", cacheCold: false })
  expect(Store.sessionCacheMetrics(zero).cacheHitRate).toBeNull()

  // The in-memory incognito schema is cloned after durable migrations and must
  // accept/query the same cache metadata without touching the durable ledger.
  const { markSessionIncognito } = await import("./incognito.ts")
  const incognito = "cache-metrics-incognito"
  markSessionIncognito(incognito, ["anthropic"])
  Store.createSession(incognito)
  Store.logUsage({ sessionId: incognito, role: "lead", provider: "anthropic", model: "claude", inputTokens: 5, cacheReadTokens: 15, cacheCold: true, wakeSource: "sidekick", detachedSpawnId: "incognito-spawn", turnIndex: 1 })
  expect(Store.sessionCacheMetrics(incognito)).toMatchObject({ turns: 1, promptTokens: 20, cacheHitRate: 0.75, coldTurns: 1, detachedWakeTurns: 1 })
  const durableIncognitoRows = new Database(dbPath).query("SELECT COUNT(*) count FROM usage_log WHERE session_id=?").get(incognito) as { count: number }
  expect(durableIncognitoRows.count).toBe(0)
  console.log("cache metrics fresh: ok")
}
