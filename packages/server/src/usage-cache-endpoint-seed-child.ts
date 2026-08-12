import { Store } from "./store.ts"

const sessionId = process.env.CACHE_ENDPOINT_SESSION!
Store.createSession(sessionId)
Store.logUsage({ sessionId, role: "lead", provider: "anthropic", model: "claude", inputTokens: 10, cacheReadTokens: 90, cacheCold: false, turnIndex: 1 })
Store.logUsage({ sessionId, role: "lead", provider: "anthropic", model: "claude", inputTokens: 30, cacheWriteTokens: 70,
  cacheCold: true, cacheColdReason: "idle", wakeSource: "sidekick", detachedSpawnId: "wake-1", turnIndex: 2 })
Store.logUsage({ sessionId, role: "child", provider: "anthropic", model: "claude", inputTokens: 999, cacheCold: true })
