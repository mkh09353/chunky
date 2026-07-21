// Rendering for the read-only /scoreboard and /usage slash commands. Pure
// string work: App.tsx fetches the payloads (lib/api.ts) and drops whatever
// these return into a notice line. Multi-line notices render monospace.
import { fmtTokens } from "./format"
import type { ScoreboardRow, UsageResponse } from "./api"

/** provider/model@effort — the identity every stats row is keyed by. */
export function modelLabel(row: { provider: string; model: string; effort: string | null }): string {
  return `${row.provider}/${row.model}${row.effort ? `@${row.effort}` : ""}`
}

const money = (v: number | null): string => (v == null ? "-" : `$${v.toFixed(2)}`)
const rating = (v: number | null): string => (v == null ? "-" : v.toFixed(1))
// The contract sends a rate (0..1); tolerate a server that already scaled it.
const percent = (v: number | null): string => (v == null ? "-" : `${Math.round(v > 1 ? v : v * 100)}%`)

type Align = "l" | "r"

/** Pad `cells` into an aligned monospace table (two-space gutters). */
export function alignTable(headers: string[], rows: string[][], align: Align[]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)))
  const line = (cells: string[]) =>
    cells
      .map((cell, i) => {
        const w = widths[i] ?? cell.length
        return (align[i] ?? "l") === "r" ? cell.padStart(w) : cell.padEnd(w)
      })
      .join("  ")
      .trimEnd()
  return [line(headers), line(widths.map((w) => "─".repeat(w))), ...rows.map(line)].join("\n")
}

/** avgRating desc, nulls last; ties broken by sample count so the busier row wins. */
export function sortScoreboard(rows: ScoreboardRow[]): ScoreboardRow[] {
  return [...rows].sort((a, b) => {
    if (a.avgRating == null && b.avgRating == null) return b.samples - a.samples
    if (a.avgRating == null) return 1
    if (b.avgRating == null) return -1
    if (b.avgRating !== a.avgRating) return b.avgRating - a.avgRating
    return b.samples - a.samples
  })
}

/** The /scoreboard table, or null when there's nothing rated yet. */
export function renderScoreboard(rows: ScoreboardRow[]): string | null {
  if (!rows.length) return null
  return alignTable(
    ["MODEL", "KIND", "N", "AVG", "REWORK", "COST", "RATING/$"],
    sortScoreboard(rows).map((r) => [
      modelLabel(r),
      r.kind,
      String(r.samples),
      rating(r.avgRating),
      percent(r.reworkRate),
      money(r.totalCost),
      r.ratingPerDollar == null ? "-" : r.ratingPerDollar.toFixed(2),
    ]),
    ["l", "l", "r", "r", "r", "r", "r"],
  )
}

/** The /usage table, or null when the session hasn't spent anything yet. */
export function renderUsage(body: UsageResponse): string | null {
  if (!body.roles.length) return null
  return alignTable(
    ["ROLE", "MODEL", "IN", "OUT", "CACHE R", "COST", "REQ"],
    body.roles.map((r) => [
      r.role,
      modelLabel(r),
      fmtTokens(r.inputTokens),
      fmtTokens(r.outputTokens),
      fmtTokens(r.cacheReadTokens),
      money(r.cost),
      String(r.requests),
    ]),
    ["l", "l", "r", "r", "r", "r", "r"],
  )
}

/** One-line roll-up printed under the /usage table. */
export function usageTotalsLine(totals: UsageResponse["totals"]): string {
  return `Total: ${fmtTokens(totals.inputTokens)} in · ${fmtTokens(totals.outputTokens)} out · ${money(totals.cost)}`
}
