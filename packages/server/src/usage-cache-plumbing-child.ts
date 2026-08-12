import { expect } from "bun:test"
import { CACHE_TTL_MS, NOTICE_MIN_TOKENS, noteRequest, resetCacheWatch } from "./cache-watch.ts"
import { classifyLeadCache, translateStream } from "./run.ts"
import { installBackgroundDispatcher, resetBackgroundDispatcher, routeBackgroundNotice } from "./background-dispatch.ts"
import { Store } from "./store.ts"

async function persistLeadUsage(sessionId: string, measurement: ReturnType<typeof classifyLeadCache>, wake?: { kind: string; detachedSpawnId: string }, turnIndex?: number) {
  async function* stream() {
    yield ["messages", [{ type: "ai", content: "done", usage_metadata: { input_tokens: 30, output_tokens: 2, input_token_details: { cache_read: 10, cache_creation: 60 } } }, {}]]
  }
  await translateStream(stream(), undefined, () => {}, undefined, undefined, {
    sessionId, selection: { provider: "anthropic", model: "claude-test" }, role: "lead",
    ...measurement, wakeSource: wake?.kind, detachedSpawnId: wake?.detachedSpawnId, turnIndex,
  })
}

const coldSession = "plumbing-cold"
Store.createSession(coldSession)
resetCacheWatch(coldSession)
const now = Date.now()
noteRequest(coldSession, { inputTokens: NOTICE_MIN_TOKENS + 1, outputTokens: 1 }, "claude-test", now - CACHE_TTL_MS - 1)
const emitted: unknown[] = []
const cold = classifyLeadCache(coldSession, "claude-test", true, (event) => emitted.push(event), now)
expect(cold).toEqual({ cacheCold: true, cacheColdReason: "idle", idleMs: CACHE_TTL_MS + 1 })
expect(emitted).toHaveLength(0) // suppression affects presentation, not accounting
let wakePersisted!: () => void
const wakeDone = new Promise<void>((resolve) => { wakePersisted = resolve })
installBackgroundDispatcher({
  isRunning: () => false,
  wake: (_sessionId, _prompt, _shown, _from, provenance) => {
    void persistLeadUsage(coldSession, cold, provenance, 7).then(wakePersisted)
  },
  changed: () => {},
})
expect(routeBackgroundNotice(coldSession, "report", "Sidekick finished", "sidekick", { kind: "sidekick", detachedSpawnId: "detached-123" })).toBe("wake")
await wakeDone
resetBackgroundDispatcher()
expect(Store.sessionCacheMetrics(coldSession)).toMatchObject({ turns: 1, coldTurns: 1, detachedWakeTurns: 1, coldDetachedWakeTurns: 1 })

const db = new (await import("bun:sqlite")).Database(process.env.CHUNKY_DB!)
expect(db.query("SELECT cache_cold cacheCold,cache_cold_reason cacheColdReason,idle_ms idleMs,wake_source wakeSource,detached_spawn_id detachedSpawnId,turn_index turnIndex FROM usage_log WHERE session_id=?").get(coldSession)).toEqual({
  cacheCold: 1, cacheColdReason: "idle", idleMs: CACHE_TTL_MS + 1, wakeSource: "sidekick", detachedSpawnId: "detached-123", turnIndex: 7,
})

const warmSession = "plumbing-warm"
Store.createSession(warmSession)
resetCacheWatch(warmSession)
noteRequest(warmSession, { inputTokens: 100, outputTokens: 1 }, "claude-test", now - 1_000)
const warm = classifyLeadCache(warmSession, "claude-test", false, () => {}, now)
expect(warm).toEqual({ cacheCold: false, cacheColdReason: undefined, idleMs: 1_000 })
await persistLeadUsage(warmSession, warm)
expect(db.query("SELECT cache_cold cacheCold,idle_ms idleMs FROM usage_log WHERE session_id=?").get(warmSession)).toEqual({ cacheCold: 0, idleMs: 1_000 })

const firstSession = "plumbing-first"
Store.createSession(firstSession)
resetCacheWatch(firstSession)
const first = classifyLeadCache(firstSession, "claude-test", false, () => {}, now)
expect(first).toEqual({ cacheCold: undefined, cacheColdReason: undefined, idleMs: undefined })
await persistLeadUsage(firstSession, first)
expect(db.query("SELECT cache_cold cacheCold,cache_cold_reason cacheColdReason,idle_ms idleMs FROM usage_log WHERE session_id=?").get(firstSession)).toEqual({ cacheCold: null, cacheColdReason: null, idleMs: null })
db.close()
console.log("cache plumbing: cold suppression, detached wake, and first-turn classification passed")
