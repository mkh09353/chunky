import { describe, expect, test } from "bun:test"
import type { Options, Query, SDKControlGetUsageResponse } from "@anthropic-ai/claude-agent-sdk"
import { fetchAnthropicQuota, parseAnthropicQuota } from "./anthropic-sdk.ts"
import { parseCodexQuotaHeaders, parseCodexUsage } from "./codex.ts"

const emptySession = {
  total_cost_usd: 0,
  total_api_duration_ms: 0,
  total_duration_ms: 0,
  total_lines_added: 0,
  total_lines_removed: 0,
  model_usage: {},
}

describe("Codex quota parsers", () => {
  test("parses primary and secondary response headers", () => {
    const windows = parseCodexQuotaHeaders(new Headers({
      "x-codex-primary-used-percent": "42.5",
      "x-codex-primary-window-minutes": "300",
      "x-codex-primary-reset-at": "2026-08-08T12:00:00Z",
      "x-codex-secondary-used-percent": "17",
      "x-codex-secondary-window-minutes": "10080",
      "x-codex-secondary-reset-at": "1786190400",
    }))
    expect(windows).toEqual([
      { kind: "five-hour", label: "5-hour", usedPercent: 42.5, resetAt: Date.parse("2026-08-08T12:00:00Z"), windowMinutes: 300 },
      { kind: "weekly", label: "Weekly", usedPercent: 17, resetAt: 1786190400000, windowMinutes: 10080 },
    ])
  })

  test("uses the actual duration when a primary window is weekly", () => {
    expect(parseCodexUsage({ rate_limit: { primary_window: { used_percent: 2, limit_window_seconds: 604_800, reset_at: 1786837196 }, secondary_window: null } })).toEqual([
      { kind: "weekly", label: "Weekly", usedPercent: 2, resetAt: 1786837196000, windowMinutes: 10080 },
    ])
  })

  test("parses the wham usage fixture and normalizes reset timestamps", () => {
    const windows = parseCodexUsage({
      plan_type: "plus",
      rate_limit: {
        primary_window: { used_percent: 61, limit_window_seconds: 18_000, reset_at: 1786190400 },
        secondary_window: { used_percent: null, limit_window_seconds: 604_800, reset_at: "2026-08-15T12:00:00Z" },
      },
      credits: { balance: 123 },
    })
    expect(windows).toEqual([
      { kind: "five-hour", label: "5-hour", usedPercent: 61, resetAt: 1786190400000, windowMinutes: 300 },
      { kind: "weekly", label: "Weekly", usedPercent: null, resetAt: Date.parse("2026-08-15T12:00:00Z"), windowMinutes: 10080 },
    ])
  })
})

describe("Anthropic quota collector", () => {
  test("maps five-hour, weekly, and model windows including null utilization", () => {
    const result = parseAnthropicQuota({
      session: emptySession,
      subscription_type: "max",
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 23.5, resets_at: "2026-08-08T12:00:00Z" },
        seven_day: { utilization: null, resets_at: "2026-08-15T12:00:00Z" },
        seven_day_opus: { utilization: 10, resets_at: null },
        model_scoped: [{ display_name: "Fable", utilization: 7, resets_at: "2026-08-15T13:00:00Z" }],
      },
      behaviors: null,
    } as SDKControlGetUsageResponse)
    expect(result.status).toBe("available")
    expect(result.windows).toEqual([
      { kind: "five-hour", label: "5-hour", usedPercent: 23.5, resetAt: Date.parse("2026-08-08T12:00:00Z") },
      { kind: "weekly", label: "Weekly", usedPercent: null, resetAt: Date.parse("2026-08-15T12:00:00Z") },
      { kind: "weekly-model", label: "Opus weekly", model: "opus", usedPercent: 10, resetAt: null },
      { kind: "weekly-model", label: "Fable", model: "Fable", usedPercent: 7, resetAt: Date.parse("2026-08-15T13:00:00Z") },
    ])
  })

  test("maps unavailable subscription limits to unsupported", () => {
    const result = parseAnthropicQuota({ session: emptySession, subscription_type: null, rate_limits_available: false, rate_limits: null, behaviors: null } as SDKControlGetUsageResponse)
    expect(result).toMatchObject({ status: "unsupported", source: "anthropic-sdk", windows: [] })
  })

  test("uses an isolated no-input control query and always closes it", async () => {
    let options: Options | undefined
    let closed = false
    const query = ((request: Parameters<typeof import("@anthropic-ai/claude-agent-sdk").query>[0]) => {
      options = request.options
      return {
        usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({ session: emptySession, subscription_type: "pro", rate_limits_available: false, rate_limits: null, behaviors: null }),
        close: () => { closed = true },
      } as unknown as Query
    }) as typeof import("@anthropic-ai/claude-agent-sdk").query
    await fetchAnthropicQuota({ query, now: () => 123 })
    expect(options?.strictMcpConfig).toBe(true)
    expect(options?.tools).toEqual([])
    expect(closed).toBe(true)
  })
})
