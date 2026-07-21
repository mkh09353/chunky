// Rendering for the read-only /scoreboard and /usage slash commands. Pure
// string work so it can be unit-tested without a terminal: App.tsx fetches the
// server payloads and prints whatever these return into the transcript.

export interface ScoreboardRow {
  provider: string
  model: string
  effort: string | null
  kind: string
  samples: number
  avgRating: number | null
  ratedCount: number
  reworkRate: number | null
  totalCost: number | null
  totalTokens: number
  ratingPerDollar: number | null
}

export interface ScoreboardResponse {
  rows: ScoreboardRow[]
}

export type UsageRole = "lead" | "sidekick" | "advisor" | "child"

export interface UsageRoleRow {
  role: UsageRole
  provider: string
  model: string
  effort: string | null
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  cost: number | null
  requests: number
}

export interface UsageResponse {
  roles: UsageRoleRow[]
  totals: {
    inputTokens: number
    outputTokens: number
    cost: number | null
  }
}

/** Compact token count: 1234 → "1.2k", 1_500_000 → "1.5M". Mirrors the
 *  transcript's fmtTokens, kept local so this module stays UI-free. */
export function compactTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0"
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 10_000) return `${Math.round(n / 1000)}k`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(Math.round(n))
}

/** provider/model@effort — the identity every stats row is keyed by. */
export function modelLabel(row: { provider: string; model: string; effort: string | null }): string {
  return `${row.provider}/${row.model}${row.effort ? `@${row.effort}` : ""}`
}

const money = (v: number | null): string => (v == null ? "-" : `$${v.toFixed(2)}`)
const rating = (v: number | null): string => (v == null ? "-" : v.toFixed(1))
// The contract sends a rate (0..1); tolerate a server that already scaled it.
const percent = (v: number | null): string => (v == null ? "-" : `${Math.round((v > 1 ? v : v * 100))}%`)

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

/** The /scoreboard table body (no fence), or null when there's nothing to show. */
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

/** The /usage table body (no fence), or null when the session has no usage yet. */
export function renderUsage(body: UsageResponse): string | null {
  if (!body.roles.length) return null
  return alignTable(
    ["ROLE", "MODEL", "IN", "OUT", "CACHE R", "COST", "REQ"],
    body.roles.map((r) => [
      r.role,
      modelLabel(r),
      compactTokens(r.inputTokens),
      compactTokens(r.outputTokens),
      compactTokens(r.cacheReadTokens),
      money(r.cost),
      String(r.requests),
    ]),
    ["l", "l", "r", "r", "r", "r", "r"],
  )
}

/** One-line roll-up printed under the /usage table. */
export function usageTotalsLine(totals: UsageResponse["totals"]): string {
  return `Total: ${compactTokens(totals.inputTokens)} in · ${compactTokens(totals.outputTokens)} out · ${money(totals.cost)}`
}
