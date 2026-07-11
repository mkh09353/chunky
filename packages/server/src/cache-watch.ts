// Prompt-cache staleness watch. The whole point: if you leave a thread idle
// past the provider's cache TTL, or switch models, the cached prefix is gone —
// the next turn silently re-sends the entire context (slow + expensive on API,
// and a signal you'd be better off in a fresh thread). We track each thread's
// last request and, at the START of the next turn, warn when the cache is cold.
//
// This is per-conversation in-memory state: it survives across turns within a
// running server, which covers the real case (you walked away for 40 minutes,
// the server stayed up). After a server restart the watch is cold and the first
// turn won't warn — acceptable; it re-arms from that turn on.
import type { AgentEvent, CacheCold, UsageDelta } from "@chunky/protocol"
import { promptTokensOf } from "./usage.ts"

/** Anthropic's default prompt-cache TTL is 5 minutes; idle gaps past this evict
 *  the cached prefix. (The 1h cache tier would need a per-model TTL; 5m is the
 *  safe floor and what the default cache_control gives.) */
export const CACHE_TTL_MS = 5 * 60 * 1000

/** Don't cry wolf: only warn when the context that must be re-sent is big enough
 *  that rebuilding the cache actually costs meaningful latency/tokens. */
export const NOTICE_MIN_TOKENS = 20_000

interface LastRequest {
  /** Prompt tokens on the thread's most recent request ≈ current context size. */
  contextTokens: number
  model: string
  /** Wall-clock ms when that request happened (last time the cache was fresh). */
  at: number
}

/** What a cold-cache check found, ready to fold into a `cache.warning` event. */
export interface CacheWarning {
  reason: "idle" | "model-switch"
  idleMs?: number
  approxTokens: number
  fromModel?: string
  toModel?: string
}

// Keyed by conversation id: the main session uses its sessionId; each resumable
// thread (e.g. the advisor) would use its own thread id. Child spawn threads run
// fresh every time and never resume, so they never register here.
const lastByConversation = new Map<string, LastRequest>()

/** Record a completed request so the NEXT turn can judge cache freshness. */
export function noteRequest(
  conversationId: string,
  delta: UsageDelta,
  model: string,
  now: number,
): void {
  const contextTokens = promptTokensOf(delta)
  if (contextTokens <= 0) return
  lastByConversation.set(conversationId, { contextTokens, model, at: now })
}

/** Drop a conversation's tracking (session delete / explicit reset). */
export function resetCacheWatch(conversationId: string): void {
  lastByConversation.delete(conversationId)
}

/**
 * At the start of a turn, decide whether this thread's cache is cold. Returns a
 * warning when the previous turn's cache is gone AND its context was large
 * enough to be worth mentioning; otherwise undefined (fresh cache, first turn,
 * or trivially small context).
 *
 * Model-switch takes precedence over idle: switching models re-bills the whole
 * prompt regardless of how recently you spoke, and it's the more actionable note.
 */
export function checkCacheCold(
  conversationId: string,
  model: string,
  now: number,
): CacheWarning | undefined {
  const prev = lastByConversation.get(conversationId)
  if (!prev) return undefined
  if (prev.contextTokens < NOTICE_MIN_TOKENS) return undefined

  const modelChanged = model !== prev.model
  const idleMs = Math.max(0, now - prev.at)

  if (modelChanged) {
    return {
      reason: "model-switch",
      approxTokens: prev.contextTokens,
      fromModel: prev.model,
      toModel: model,
    }
  }
  if (idleMs >= CACHE_TTL_MS) {
    return { reason: "idle", idleMs, approxTokens: prev.contextTokens }
  }
  return undefined
}

/**
 * True when a cold-cache send is big enough that the guard should refuse it and
 * ask the user first (before any tokens are spent). `guardTokens === null`
 * means the guard is off.
 */
export function exceedsGuard(
  warning: CacheWarning | undefined,
  guardTokens: number | null,
): warning is CacheWarning {
  return warning != null && guardTokens != null && warning.approxTokens >= guardTokens
}

/** The REST-shaped warning (the same fields the cache.warning event carries). */
export function cacheColdPayload(warning: CacheWarning): CacheCold {
  return {
    reason: warning.reason,
    approxTokens: warning.approxTokens,
    ...(warning.idleMs != null ? { idleMs: warning.idleMs } : {}),
    ...(warning.fromModel ? { fromModel: warning.fromModel } : {}),
    ...(warning.toModel ? { toModel: warning.toModel } : {}),
  }
}

/** Assemble the wire event from a warning (main-session convId === sessionId). */
export function cacheWarningEvent(
  sessionId: string,
  warning: CacheWarning,
  threadId?: string,
): Extract<AgentEvent, { type: "cache.warning" }> {
  return {
    type: "cache.warning",
    sessionId,
    ...cacheColdPayload(warning),
    ...(threadId ? { threadId } : {}),
  }
}
