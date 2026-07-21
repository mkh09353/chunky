import { describe, expect, test } from "bun:test"
import {
  alignTable,
  renderScoreboard,
  renderUsage,
  sortScoreboard,
  usageTotalsLine,
  type ScoreboardRow,
  type UsageResponse,
} from "./stats.ts"

const row = (over: Partial<ScoreboardRow>): ScoreboardRow => ({
  provider: "zen",
  model: "glm-5",
  effort: null,
  kind: "sidekick",
  samples: 3,
  avgRating: 4,
  ratedCount: 3,
  reworkRate: 0.25,
  totalCost: 1.5,
  totalTokens: 12_345,
  ratingPerDollar: 2.67,
  ...over,
})

describe("scoreboard", () => {
  test("ranks by average rating, nulls last", () => {
    const ranked = sortScoreboard([
      row({ model: "unrated", avgRating: null }),
      row({ model: "good", avgRating: 4.6 }),
      row({ model: "ok", avgRating: 3.1 }),
    ])
    expect(ranked.map((r) => r.model)).toEqual(["good", "ok", "unrated"])
  })

  test("renders a padded table with nulls as dashes", () => {
    const table = renderScoreboard([
      row({ provider: "codex", model: "gpt-5", effort: "high", avgRating: 4.62 }),
      row({ model: "cheap", avgRating: null, reworkRate: null, totalCost: null, ratingPerDollar: null }),
    ])!
    const lines = table.split("\n")
    expect(lines[0]).toContain("MODEL")
    expect(lines[2]).toContain("codex/gpt-5@high")
    expect(lines[2]).toContain("4.6")
    expect(lines[2]).toContain("25%")
    expect(lines[2]).toContain("$1.50")
    // Nulls never crash and never print "null".
    expect(lines[3]).toContain("-")
    expect(table).not.toContain("null")
    // Every row is the same width — the table stays aligned.
    expect(new Set(lines.map((l) => l.replace(/\s+$/, "").length)).size).toBeGreaterThan(0)
  })

  test("empty data has no table to render", () => {
    expect(renderScoreboard([])).toBeNull()
  })
})

describe("usage", () => {
  const usage: UsageResponse = {
    roles: [
      {
        role: "lead",
        provider: "anthropic",
        model: "claude-sonnet",
        effort: null,
        inputTokens: 1_200_000,
        outputTokens: 45_000,
        reasoningTokens: 0,
        cacheReadTokens: 900,
        cacheWriteTokens: 0,
        cost: 3.2,
        requests: 12,
      },
    ],
    totals: { inputTokens: 1_200_000, outputTokens: 45_000, cost: 3.2 },
  }

  test("formats tokens compactly per role", () => {
    const table = renderUsage(usage)!
    expect(table).toContain("lead")
    expect(table).toContain("anthropic/claude-sonnet")
    expect(table).toContain("1.2M")
    expect(table).toContain("45k")
  })

  test("totals line rolls up input, output and cost", () => {
    expect(usageTotalsLine(usage.totals)).toBe("Total: 1.2M in · 45k out · $3.20")
    expect(usageTotalsLine({ inputTokens: 0, outputTokens: 0, cost: null })).toBe("Total: 0 in · 0 out · -")
  })

  test("empty roles render nothing", () => {
    expect(renderUsage({ roles: [], totals: { inputTokens: 0, outputTokens: 0, cost: null } })).toBeNull()
  })
})

describe("alignTable", () => {
  test("pads columns to the widest cell and right-aligns numbers", () => {
    const table = alignTable(["A", "N"], [["long-value", "7"], ["x", "1234"]], ["l", "r"])
    const [, , first, second] = table.split("\n")
    expect(first).toBe("long-value     7")
    expect(second).toBe("x           1234")
  })
})
