import { describe, expect, test, beforeEach } from "bun:test"
import {
  CACHE_TTL_MS,
  NOTICE_MIN_TOKENS,
  cacheColdPayload,
  cacheWarningEvent,
  checkCacheCold,
  exceedsGuard,
  noteRequest,
  resetCacheWatch,
} from "./cache-watch.ts"

const CONV = "sess-cache-test"
const BIG = NOTICE_MIN_TOKENS + 50_000 // a context worth warning about
const T0 = 1_000_000_000_000 // fixed base timestamp (ms)

beforeEach(() => resetCacheWatch(CONV))

describe("checkCacheCold", () => {
  test("no warning on the very first turn (nothing tracked yet)", () => {
    expect(checkCacheCold(CONV, "claude-opus-4-8", T0)).toBeUndefined()
  })

  test("no warning when the next turn is within the cache TTL", () => {
    noteRequest(CONV, { inputTokens: BIG, outputTokens: 100 }, "claude-opus-4-8", T0)
    const soon = T0 + CACHE_TTL_MS - 1
    expect(checkCacheCold(CONV, "claude-opus-4-8", soon)).toBeUndefined()
  })

  test("warns after an idle gap past the TTL", () => {
    noteRequest(CONV, { inputTokens: BIG, outputTokens: 100 }, "claude-opus-4-8", T0)
    const later = T0 + 42 * 60_000 // 42 minutes
    const w = checkCacheCold(CONV, "claude-opus-4-8", later)
    expect(w?.reason).toBe("idle")
    expect(w?.idleMs).toBe(42 * 60_000)
    expect(w?.approxTokens).toBe(BIG)
  })

  test("warns on a model switch even within the TTL", () => {
    noteRequest(CONV, { inputTokens: BIG, outputTokens: 100 }, "claude-opus-4-8", T0)
    const soon = T0 + 30_000 // 30s later, but different model
    const w = checkCacheCold(CONV, "glm-5.2", soon)
    expect(w?.reason).toBe("model-switch")
    expect(w?.fromModel).toBe("claude-opus-4-8")
    expect(w?.toModel).toBe("glm-5.2")
  })

  test("model-switch takes precedence over idle", () => {
    noteRequest(CONV, { inputTokens: BIG, outputTokens: 100 }, "claude-opus-4-8", T0)
    const w = checkCacheCold(CONV, "glm-5.2", T0 + 99 * 60_000)
    expect(w?.reason).toBe("model-switch")
  })

  test("stays quiet when the context is too small to matter", () => {
    noteRequest(CONV, { inputTokens: 5_000, outputTokens: 100 }, "claude-opus-4-8", T0)
    expect(checkCacheCold(CONV, "claude-opus-4-8", T0 + 60 * 60_000)).toBeUndefined()
  })

  test("prompt size follows the LATEST request (cache is re-armed each turn)", () => {
    noteRequest(CONV, { inputTokens: BIG, outputTokens: 100 }, "claude-opus-4-8", T0)
    // A warm follow-up turn refreshes the timestamp; no warning next time if soon.
    noteRequest(CONV, { inputTokens: BIG + 20_000, outputTokens: 80 }, "claude-opus-4-8", T0 + 60_000)
    const w = checkCacheCold(CONV, "claude-opus-4-8", T0 + 60_000 + 10 * 60_000)
    expect(w?.approxTokens).toBe(BIG + 20_000)
    expect(w?.idleMs).toBe(10 * 60_000)
  })

  test("counts cache read/write tokens toward the context size", () => {
    // Small fresh input but a big cached prefix still means a big re-send on a miss.
    noteRequest(
      CONV,
      { inputTokens: 1_000, outputTokens: 50, cacheReadTokens: BIG, cacheWriteTokens: 0 },
      "claude-opus-4-8",
      T0,
    )
    const w = checkCacheCold(CONV, "claude-opus-4-8", T0 + 10 * 60_000)
    expect(w?.approxTokens).toBe(BIG + 1_000)
  })

  test("a zero-token request does not arm the watch", () => {
    noteRequest(CONV, { inputTokens: 0, outputTokens: 0 }, "claude-opus-4-8", T0)
    expect(checkCacheCold(CONV, "claude-opus-4-8", T0 + 60 * 60_000)).toBeUndefined()
  })
})

describe("cacheWarningEvent", () => {
  test("builds an idle wire event, omitting empty optional fields", () => {
    const ev = cacheWarningEvent(CONV, { reason: "idle", idleMs: 600_000, approxTokens: 90_000 })
    expect(ev).toEqual({
      type: "cache.warning",
      sessionId: CONV,
      reason: "idle",
      idleMs: 600_000,
      approxTokens: 90_000,
    })
    expect("threadId" in ev).toBe(false)
    expect("fromModel" in ev).toBe(false)
  })

  test("carries model-switch fields and a threadId when supplied", () => {
    const ev = cacheWarningEvent(
      CONV,
      { reason: "model-switch", approxTokens: 90_000, fromModel: "a", toModel: "b" },
      "thr-1",
    )
    expect(ev.reason).toBe("model-switch")
    expect(ev.fromModel).toBe("a")
    expect(ev.toModel).toBe("b")
    expect(ev.threadId).toBe("thr-1")
    expect("idleMs" in ev).toBe(false)
  })
})

describe("exceedsGuard", () => {
  const warning = { reason: "idle" as const, idleMs: 600_000, approxTokens: 90_000 }

  test("blocks a cold send at or above the threshold", () => {
    expect(exceedsGuard(warning, 90_000)).toBe(true)
    expect(exceedsGuard(warning, 50_000)).toBe(true)
  })

  test("lets a cold send below the threshold through (post-hoc notice only)", () => {
    expect(exceedsGuard(warning, 90_001)).toBe(false)
  })

  test("never blocks with a warm cache or a disabled guard", () => {
    expect(exceedsGuard(undefined, 50_000)).toBe(false)
    expect(exceedsGuard(warning, null)).toBe(false)
  })
})

describe("cacheColdPayload", () => {
  test("omits empty optional fields on the REST shape too", () => {
    expect(cacheColdPayload({ reason: "idle", idleMs: 600_000, approxTokens: 90_000 })).toEqual({
      reason: "idle",
      idleMs: 600_000,
      approxTokens: 90_000,
    })
    const sw = cacheColdPayload({ reason: "model-switch", approxTokens: 90_000, fromModel: "a", toModel: "b" })
    expect(sw).toEqual({ reason: "model-switch", approxTokens: 90_000, fromModel: "a", toModel: "b" })
    expect("idleMs" in sw).toBe(false)
  })
})
