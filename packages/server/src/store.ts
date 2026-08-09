// Durable session + event store on bun:sqlite (native, no build step).
// Makes transcripts survive a server restart, so reconnecting to a sessionId
// replays the full prior run — i.e. "resume". Kept deliberately tiny.
import { openSqlite, retrySqliteTransaction } from "./sqlite.ts"
import type { AgentEvent, RewindPoint, SessionSummary, UsageBreakdownResponse, UsageSeriesResponse } from "@chunky/protocol"
import { notifySessionChanged } from "./session-changes.ts"
import type { Goal } from "./goal.ts"
import type { TodoSnapshot } from "./todos.ts"
import type { AgentSelection } from "./providers/registry.ts"
import type { AdvisorConfig, ReviewConfig, SidekickConfig, SidekickSeat } from "./settings.ts"
import { LAUNCH_WORKSPACE } from "./workspace.ts"
import { pricingFor } from "./providers/models-catalog.ts"
import { isIncognitoSession } from "./incognito.ts"

/** A session's pinned model choice (type-only alias — the import is erased, so
 *  the store keeps zero runtime provider dependencies). */
export type PinnedSelection = AgentSelection & { solo?: boolean }
/** Complete session-local mode materialization. Unlike sparse legacy overrides,
 * every field is concrete so later global changes cannot leak into this mode. */
export type SessionAgentConfig = {
  activeMode: string
  selection: PinnedSelection
  advisor: AdvisorConfig
  review: ReviewConfig
  sidekick: SidekickConfig
  sidekickSeats: Record<string, SidekickSeat>
}
/** Per-session changes layered over the server-wide sidekick defaults. A null
 * seat clears this session's override and therefore reveals the global seat. */
export type SessionSidekickOverride = {
  config?: Partial<SidekickConfig>
  seats?: Record<string, SidekickSeat | null>
}
export type UsageLedgerInput = {
  sessionId: string; threadId?: string; role: "lead" | "sidekick" | "advisor" | "review" | "child"
  provider: string; model: string; effort?: string | null; delegationId?: string | null
  inputTokens?: number; outputTokens?: number; reasoningTokens?: number
  cacheReadTokens?: number; cacheWriteTokens?: number; ts?: number
}
export type DelegationInput = { id: string; sessionId: string; kind: "sidekick" | "review" | "child" | "workflow_agent"; seat?: string; provider: string; model: string; effort?: string; briefSnippet: string }

/** The durable path is fixed when this module opens its connection. Exporting it
 * lets diagnostics/tests inspect that same database rather than a later-mutated
 * process environment (test modules deliberately isolate settings paths). */
export const durableDbPath = process.env.CHUNKY_DB || "chunky.db"
const DB_PATH = durableDbPath
const db = openSqlite(DB_PATH)
// Incognito data is deliberately process-local. Keep a separate connection so
// accidental SQL against the durable database cannot expose it.
const memoryDb = openSqlite(":memory:")
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id            TEXT PRIMARY KEY,
    title         TEXT NOT NULL DEFAULT 'New session',
    title_custom  INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL,
    last_activity INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS events (
    session_id TEXT NOT NULL,
    seq        INTEGER NOT NULL,
    json       TEXT NOT NULL,
    PRIMARY KEY (session_id, seq)
  );
  CREATE TABLE IF NOT EXISTS goals (
    session_id    TEXT PRIMARY KEY,
    objective     TEXT NOT NULL,
    status        TEXT NOT NULL,
    mode          TEXT NOT NULL DEFAULT 'direct',
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    turns         INTEGER NOT NULL DEFAULT 0,
    max_turns     INTEGER NOT NULL,
    evidence      TEXT,
    blocked_reason TEXT
  );
  CREATE TABLE IF NOT EXISTS todos (
    session_id TEXT PRIMARY KEY,
    json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS session_turns (
    session_id TEXT NOT NULL, turn_index INTEGER NOT NULL, start_event_seq INTEGER NOT NULL,
    end_event_seq INTEGER, snapshot_commit TEXT, anchor_checkpoint_id TEXT, user_text TEXT NOT NULL,
    status TEXT NOT NULL, created_at INTEGER NOT NULL, completed_at INTEGER,
    PRIMARY KEY (session_id, turn_index)
  );
  CREATE TABLE IF NOT EXISTS session_branches (
    child_session_id TEXT PRIMARY KEY, parent_session_id TEXT NOT NULL, fork_event_seq INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('normal', 'worktree')), directive TEXT, created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS session_workspaces (
    session_id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('directory', 'worktree')), path TEXT NOT NULL,
    git_common_dir TEXT, branch TEXT, parent_session_id TEXT, created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS usage_log (
    id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, thread_id TEXT, role TEXT NOT NULL,
    provider TEXT NOT NULL, model TEXT NOT NULL, effort TEXT, delegation_id TEXT, ts INTEGER NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
    reasoning_tokens INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0, cost REAL
  );
  CREATE TABLE IF NOT EXISTS delegations (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, kind TEXT NOT NULL, seat TEXT,
    provider TEXT NOT NULL, model TEXT NOT NULL, effort TEXT, brief_snippet TEXT NOT NULL,
    started_at INTEGER NOT NULL, completed_at INTEGER, ok INTEGER
  );
  CREATE TABLE IF NOT EXISTS ratings (
    delegation_id TEXT PRIMARY KEY, rating INTEGER NOT NULL, rework INTEGER NOT NULL DEFAULT 0,
    reason TEXT NOT NULL, failure_diagnosis TEXT, judge_provider TEXT NOT NULL, judge_model TEXT NOT NULL, ts INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS session_compaction_artifacts (
    session_id TEXT PRIMARY KEY, provider TEXT NOT NULL, model TEXT NOT NULL,
    replacement_history_json TEXT NOT NULL, boundary TEXT NOT NULL,
    created_at INTEGER NOT NULL, usage_json TEXT
  );
  CREATE TABLE IF NOT EXISTS archived_sessions (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, workspace TEXT NOT NULL,
    created_at INTEGER NOT NULL, last_activity INTEGER NOT NULL, archived_at INTEGER NOT NULL,
    byte_length INTEGER, sha256 TEXT
  );
`)

// Migration: sessions gained a `workspace` column so each repo has its own
// thread list — and, since workspaces went per-session, so each run knows which
// folder it operates on. Add it if an older db predates it, and backfill
// existing rows to the launch workspace — they all ran there before repos existed.
{
  const cols = db.query("PRAGMA table_info(sessions)").all() as { name: string }[]
  if (!cols.some((c) => c.name === "workspace")) {
    db.exec("ALTER TABLE sessions ADD COLUMN workspace TEXT")
    db.query("UPDATE sessions SET workspace = ? WHERE workspace IS NULL").run(LAUNCH_WORKSPACE)
  }
  // `selection`: an optional pinned model selection (JSON AgentSelection) so a
  // session can run a DIFFERENT model than the global active one — how a shipped
  // goal session keeps its orchestrator model while the user's session moves on.
  if (!cols.some((c) => c.name === "selection")) {
    db.exec("ALTER TABLE sessions ADD COLUMN selection TEXT")
  }
  // Optional session-local sidekick configuration, parallel to `selection`.
  if (!cols.some((c) => c.name === "sidekick")) {
    db.exec("ALTER TABLE sessions ADD COLUMN sidekick TEXT")
  }
  if (!cols.some((c) => c.name === "agent_config")) {
    db.exec("ALTER TABLE sessions ADD COLUMN agent_config TEXT")
  }
  if (!cols.some((c) => c.name === "incognito")) db.exec("ALTER TABLE sessions ADD COLUMN incognito INTEGER NOT NULL DEFAULT 0")
  if (!cols.some((c) => c.name === "incognito_allow")) db.exec("ALTER TABLE sessions ADD COLUMN incognito_allow TEXT")
  if (!cols.some((c) => c.name === "title_custom")) db.exec("ALTER TABLE sessions ADD COLUMN title_custom INTEGER NOT NULL DEFAULT 0")
}

{
  const cols = db.query("PRAGMA table_info(archived_sessions)").all() as { name: string }[]
  if (!cols.some((c) => c.name === "byte_length")) db.exec("ALTER TABLE archived_sessions ADD COLUMN byte_length INTEGER")
  if (!cols.some((c) => c.name === "sha256")) db.exec("ALTER TABLE archived_sessions ADD COLUMN sha256 TEXT")
}

// Migration: ratings gained an optional diagnosis for learning from failed or
// reworked delegations. Keep it nullable so historical ratings remain valid.
{
  const cols = db.query("PRAGMA table_info(ratings)").all() as { name: string }[]
  if (!cols.some((c) => c.name === "failure_diagnosis")) {
    db.exec("ALTER TABLE ratings ADD COLUMN failure_diagnosis TEXT")
  }
}

// Mirror the complete, migrated durable schema exactly. Incognito rows never
// use the durable connection; this copy only defines the in-process database.
for (const row of db.query("SELECT sql FROM sqlite_master WHERE type='table' AND sql IS NOT NULL").all() as Array<{ sql: string }>) memoryDb.exec(row.sql)
function backend(sessionId: string) { return isIncognitoSession(sessionId) ? memoryDb : db }

type UsageDashboardScope = { scope: "all" | "session"; sessionId?: string }
type BillingLookup = (provider: string) => string | null
type UsageAggregate = {
  day?: string; provider: string; model: string; requests: number
  inputTokens: number; outputTokens: number; reasoningTokens: number
  cacheReadTokens: number; cacheWriteTokens: number
}

function usageConnection(scope: UsageDashboardScope) {
  return scope.scope === "session" ? backend(scope.sessionId!) : db
}

/** Local-midnight bounds: dashboard dates intentionally follow server time. */
function localDateStart(date: string): number {
  const [year, month, day] = date.split("-").map(Number)
  return new Date(year!, month! - 1, day!).getTime()
}
function localDateString(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
}
function nextLocalDate(date: string): string {
  const next = new Date(localDateStart(date)); next.setDate(next.getDate() + 1); return localDateString(next)
}
function tokenTotal(row: Pick<UsageAggregate, "inputTokens" | "outputTokens" | "reasoningTokens" | "cacheReadTokens" | "cacheWriteTokens">): number {
  return row.inputTokens + row.outputTokens + row.reasoningTokens + row.cacheReadTokens + row.cacheWriteTokens
}
function whatIfCost(row: UsageAggregate): { cost: number; savings: number; priced: boolean } {
  const pricing = pricingFor(row.model)
  if (!pricing) return { cost: 0, savings: 0, priced: false }
  // Catalog entries normally carry cache rates. If one does not, model the
  // conventional 90%-discount cache read rather than silently treating it free.
  const cacheRead = pricing.cacheRead ?? pricing.input * 0.1
  const cacheWrite = pricing.cacheWrite ?? pricing.input
  return {
    cost: (row.inputTokens * pricing.input + row.outputTokens * pricing.output + row.cacheReadTokens * cacheRead + row.cacheWriteTokens * cacheWrite) / 1_000_000,
    savings: row.cacheReadTokens * (pricing.input - cacheRead) / 1_000_000,
    priced: true,
  }
}
function usageAggregates(scope: UsageDashboardScope, from: string, to: string, daily: boolean): UsageAggregate[] {
  const conn = usageConnection(scope)
  const sessionWhere = scope.scope === "session" ? "AND session_id = $session" : ""
  const day = daily ? "date(ts / 1000, 'unixepoch', 'localtime') day," : ""
  const group = daily ? "day,provider,model" : "provider,model"
  return conn.query(`SELECT ${day}provider,model,COUNT(*) requests,
    SUM(input_tokens) inputTokens,SUM(output_tokens) outputTokens,SUM(reasoning_tokens) reasoningTokens,
    SUM(cache_read_tokens) cacheReadTokens,SUM(cache_write_tokens) cacheWriteTokens
    FROM usage_log WHERE ts >= $start AND ts < $end ${sessionWhere} GROUP BY ${group}`)
    .all(scope.scope === "session"
      ? { $start: localDateStart(from), $end: localDateStart(nextLocalDate(to)), $session: scope.sessionId! }
      : { $start: localDateStart(from), $end: localDateStart(nextLocalDate(to)) }) as UsageAggregate[]
}
function ratingAggregates(scope: UsageDashboardScope, from: string, to: string): Array<{ provider: string; model: string; avgRating: number | null; ratedCount: number; reworkRate: number | null }> {
  const conn = usageConnection(scope)
  const sessionWhere = scope.scope === "session" ? "AND d.session_id = $session" : ""
  return conn.query(`SELECT d.provider,d.model,AVG(r.rating) avgRating,COUNT(r.rating) ratedCount,AVG(r.rework) reworkRate
    FROM delegations d LEFT JOIN ratings r ON r.delegation_id=d.id
    WHERE EXISTS (SELECT 1 FROM usage_log u WHERE u.delegation_id=d.id AND u.ts >= $start AND u.ts < $end)
    ${sessionWhere} GROUP BY d.provider,d.model`)
    .all(scope.scope === "session"
      ? { $start: localDateStart(from), $end: localDateStart(nextLocalDate(to)), $session: scope.sessionId! }
      : { $start: localDateStart(from), $end: localDateStart(nextLocalDate(to)) }) as any[]
}

// Migration: goals gained `mode` ('direct' | 'workflows'). Older rows were all
// hands-on direct goals.
{
  const cols = db.query("PRAGMA table_info(goals)").all() as { name: string }[]
  if (!cols.some((c) => c.name === "mode")) {
    db.exec("ALTER TABLE goals ADD COLUMN mode TEXT NOT NULL DEFAULT 'direct'")
  }
}

const stmtCreate = db.query(
  "INSERT INTO sessions (id, title, created_at, last_activity, workspace, incognito, incognito_allow) VALUES (?, ?, ?, ?, ?, 0, NULL)",
)
const stmtIncognito = db.query("UPDATE sessions SET incognito = ?, incognito_allow = ? WHERE id = ?")
const stmtGetIncognito = db.query("SELECT incognito, incognito_allow FROM sessions WHERE id = ?")
const stmtIncognitoRows = db.query("SELECT id as sessionId, incognito, incognito_allow as incognitoAllow FROM sessions WHERE incognito = 1")
const stmtTouch = db.query("UPDATE sessions SET last_activity = ? WHERE id = ?")
const stmtTitle = db.query("UPDATE sessions SET title = ? WHERE id = ?")
const stmtExists = db.query("SELECT 1 FROM sessions WHERE id = ?")
const stmtListAll = db.query(
  "SELECT id, title, created_at, last_activity, workspace FROM sessions ORDER BY last_activity DESC LIMIT 100",
)
const stmtListByWorkspace = db.query(
  "SELECT id, title, created_at, last_activity, workspace FROM sessions WHERE workspace = ? ORDER BY last_activity DESC LIMIT 100",
)
const stmtWorkspace = db.query("SELECT workspace FROM sessions WHERE id = ?")
const stmtTitleOf = db.query("SELECT title FROM sessions WHERE id = ?")
const stmtNextSeq = db.query("SELECT COALESCE(MAX(seq), -1) + 1 AS n FROM events WHERE session_id = ?")
const stmtInsertEvent = db.query("INSERT INTO events (session_id, seq, json) VALUES (?, ?, ?)")
const stmtHistory = db.query("SELECT json FROM events WHERE session_id = ? ORDER BY seq ASC")
const stmtHistoryWithSeq = db.query("SELECT seq, json FROM events WHERE session_id = ? ORDER BY seq ASC")
const recentHistorySql = "SELECT seq, json FROM events WHERE session_id = ? ORDER BY seq DESC LIMIT ?"
const statusEventsSql = "SELECT json FROM events WHERE session_id = ? AND json_extract(json, '$.type') IN ('session.status', 'thread.spawn', 'thread.status') ORDER BY seq ASC"
const stmtLastSeq = db.query("SELECT MAX(seq) AS n FROM events WHERE session_id = ?")
const stmtNextTurn = db.query("SELECT COALESCE(MAX(turn_index), 0) + 1 AS n FROM session_turns WHERE session_id = ?")
const stmtInsertTurn = db.query("INSERT INTO session_turns (session_id, turn_index, start_event_seq, snapshot_commit, user_text, status, created_at) VALUES (?, ?, ?, ?, ?, 'running', ?)")
const stmtCompleteTurn = db.query("UPDATE session_turns SET end_event_seq = ?, anchor_checkpoint_id = ?, status = 'complete', completed_at = ? WHERE session_id = ? AND turn_index = ?")
const stmtPoints = db.query("SELECT turn_index, created_at, user_text, snapshot_commit, anchor_checkpoint_id FROM session_turns WHERE session_id = ? ORDER BY turn_index DESC")
const stmtTurn = db.query("SELECT * FROM session_turns WHERE session_id = ? AND turn_index = ?")
const stmtTruncateEvents = db.query("DELETE FROM events WHERE session_id = ? AND seq >= ?")
const stmtTruncateTurns = db.query("DELETE FROM session_turns WHERE session_id = ? AND turn_index >= ?")
const stmtGetGoal = db.query("SELECT * FROM goals WHERE session_id = ?")
const stmtUpsertGoal = db.query(
  `INSERT INTO goals (session_id, objective, status, mode, created_at, updated_at, turns, max_turns, evidence, blocked_reason)
   VALUES ($session_id, $objective, $status, $mode, $created_at, $updated_at, $turns, $max_turns, $evidence, $blocked_reason)
   ON CONFLICT(session_id) DO UPDATE SET
     objective = $objective, status = $status, mode = $mode, updated_at = $updated_at, turns = $turns,
     max_turns = $max_turns, evidence = $evidence, blocked_reason = $blocked_reason`,
)
const stmtClearGoal = db.query("DELETE FROM goals WHERE session_id = ?")
const stmtGetTodos = db.query("SELECT json FROM todos WHERE session_id = ?")
const stmtPutTodos = db.query("INSERT INTO todos (session_id, json) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET json = excluded.json")
const stmtClearTodos = db.query("DELETE FROM todos WHERE session_id = ?")
const stmtSelection = db.query("SELECT selection FROM sessions WHERE id = ?")
const stmtPinSelection = db.query("UPDATE sessions SET selection = ? WHERE id = ?")
const stmtCopyEvents = db.query("INSERT INTO events (session_id, seq, json) SELECT ?, seq, json FROM events WHERE session_id = ? ORDER BY seq")
const stmtCopyTurns = db.query("INSERT INTO session_turns (session_id, turn_index, start_event_seq, end_event_seq, snapshot_commit, anchor_checkpoint_id, user_text, status, created_at, completed_at) SELECT ?, turn_index, start_event_seq, end_event_seq, snapshot_commit, anchor_checkpoint_id, user_text, status, created_at, completed_at FROM session_turns WHERE session_id = ?")
const stmtBranch = db.query("INSERT INTO session_branches VALUES (?, ?, ?, ?, ?, ?)")
const stmtWorktree = db.query("INSERT INTO session_workspaces VALUES (?, 'worktree', ?, ?, ?, ?, ?)")
const stmtBranchOf = db.query("SELECT * FROM session_branches WHERE child_session_id = ?")
const stmtWorkspaceMeta = db.query("SELECT * FROM session_workspaces WHERE session_id = ?")
const stmtUsage = db.query(`INSERT INTO usage_log
 (session_id,thread_id,role,provider,model,effort,delegation_id,ts,input_tokens,output_tokens,reasoning_tokens,cache_read_tokens,cache_write_tokens,cost)
 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
const stmtSetCompaction = db.query(`INSERT INTO session_compaction_artifacts
 (session_id,provider,model,replacement_history_json,boundary,created_at,usage_json)
 VALUES (?,?,?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET provider=excluded.provider,
 model=excluded.model,replacement_history_json=excluded.replacement_history_json,
 boundary=excluded.boundary,created_at=excluded.created_at,usage_json=excluded.usage_json`)
const appendEventTx = (sessionId: string, ev: AgentEvent, now: number) => {
  const row = stmtNextSeq.get(sessionId) as { n: number }
  stmtInsertEvent.run(sessionId, row.n, JSON.stringify(ev))
  stmtTouch.run(now, sessionId)
}

interface GoalRow {
  session_id: string
  objective: string
  status: string
  mode: string | null
  created_at: number
  updated_at: number
  turns: number
  max_turns: number
  evidence: string | null
  blocked_reason: string | null
}

function rowToGoal(row: GoalRow): Goal {
  return {
    sessionId: row.session_id,
    objective: row.objective,
    status: row.status as Goal["status"],
    mode: (row.mode as Goal["mode"]) ?? "direct",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    turns: row.turns,
    maxTurns: row.max_turns,
    evidence: row.evidence ?? undefined,
    blockedReason: row.blocked_reason ?? undefined,
  }
}

export const Store = {
  createDelegation(d: DelegationInput): void { try { backend(d.sessionId).query("INSERT INTO delegations (id,session_id,kind,seat,provider,model,effort,brief_snippet,started_at) VALUES (?,?,?,?,?,?,?,?,?)").run(d.id,d.sessionId,d.kind,d.seat??null,d.provider,d.model,d.effort ?? null,d.briefSnippet.slice(0,200),Date.now()) } catch {} },
  completeDelegation(id: string, ok: boolean): void { try { for (const conn of [db, memoryDb]) conn.query("UPDATE delegations SET completed_at=?,ok=? WHERE id=?").run(Date.now(),ok?1:0,id) } catch {} },
  rateDelegation(id: string, rating: number, rework: boolean, reason: string, judge: AgentSelection, diagnosis?: string): void { for (const conn of [db, memoryDb]) conn.query("INSERT INTO ratings (delegation_id,rating,rework,reason,failure_diagnosis,judge_provider,judge_model,ts) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(delegation_id) DO UPDATE SET rating=excluded.rating,rework=excluded.rework,reason=excluded.reason,failure_diagnosis=excluded.failure_diagnosis,judge_provider=excluded.judge_provider,judge_model=excluded.judge_model,ts=excluded.ts").run(...([id,rating,rework?1:0,reason,diagnosis ?? null,judge.provider,judge.model,Date.now()] as any)) },
  resolveDelegation(sessionId: string, ref: string): string | null { const conn=backend(sessionId); const seat = ref.startsWith("last:") ? ref.slice(5) : null; const row = conn.query(`SELECT id FROM delegations WHERE session_id=? AND completed_at IS NOT NULL ${seat ? "AND seat=?" : ""} ORDER BY completed_at DESC LIMIT 1`).get(...(seat ? [sessionId,seat] : [sessionId])) as {id:string}|null; return ref !== "last" && !ref.startsWith("last:") ? (conn.query("SELECT id FROM delegations WHERE session_id=? AND id=?").get(sessionId,ref) as {id:string}|null)?.id ?? null : row?.id ?? null },
  /** Best effort by design: accounting must never affect an agent run. */
  logUsage(u: UsageLedgerInput): void {
    try {
      const input = u.inputTokens ?? 0, output = u.outputTokens ?? 0
      const read = u.cacheReadTokens ?? 0, write = u.cacheWriteTokens ?? 0
      const p = pricingFor(u.model)
      const cost = p ? (input * p.input + output * p.output + read * p.cacheRead + write * p.cacheWrite) / 1_000_000 : null
      backend(u.sessionId).query(`INSERT INTO usage_log (session_id,thread_id,role,provider,model,effort,delegation_id,ts,input_tokens,output_tokens,reasoning_tokens,cache_read_tokens,cache_write_tokens,cost) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(u.sessionId, u.threadId ?? null, u.role, u.provider, u.model, u.effort ?? null, u.delegationId ?? null,
        u.ts ?? Date.now(), input, output, u.reasoningTokens ?? 0, read, write, cost)
    } catch { /* intentionally swallowed */ }
  },
  usageRows(sessionId: string) { return backend(sessionId).query("SELECT role,provider,model,effort,SUM(input_tokens) inputTokens,SUM(output_tokens) outputTokens,SUM(reasoning_tokens) reasoningTokens,SUM(cache_read_tokens) cacheReadTokens,SUM(cache_write_tokens) cacheWriteTokens,SUM(cost) cost,COUNT(*) requests FROM usage_log WHERE session_id = ? GROUP BY role,provider,model,effort").all(sessionId) as any[] },
  usageSeries(scope: UsageDashboardScope, from: string, to: string, billingFor: BillingLookup): UsageSeriesResponse {
    const grouped = new Map<string, UsageAggregate[]>()
    for (const row of usageAggregates(scope, from, to, true)) {
      const rows = grouped.get(row.day!) ?? []; rows.push(row); grouped.set(row.day!, rows)
    }
    const buckets: UsageSeriesResponse["buckets"] = []
    for (let date = from; date <= to; date = nextLocalDate(date)) {
      const rows = grouped.get(date) ?? []
      const providers = new Map<string, { provider: string; billing: string | null; estimatedApiCost: number; tokens: number }>()
      let requests = 0, inputTokens = 0, outputTokens = 0, reasoningTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0, estimatedApiCost = 0, unpricedRequests = 0
      for (const row of rows) {
        const priced = whatIfCost(row); requests += row.requests; inputTokens += row.inputTokens; outputTokens += row.outputTokens
        reasoningTokens += row.reasoningTokens; cacheReadTokens += row.cacheReadTokens; cacheWriteTokens += row.cacheWriteTokens
        estimatedApiCost += priced.cost; if (!priced.priced) unpricedRequests += row.requests
        const provider = providers.get(row.provider) ?? { provider: row.provider, billing: billingFor(row.provider), estimatedApiCost: 0, tokens: 0 }
        provider.estimatedApiCost += priced.cost; provider.tokens += tokenTotal(row); providers.set(row.provider, provider)
      }
      buckets.push({ date, requests, inputTokens, outputTokens, reasoningTokens, cacheReadTokens, cacheWriteTokens,
        estimatedApiCost, unpricedRequests, byProvider: [...providers.values()].sort((a, b) => b.estimatedApiCost - a.estimatedApiCost || a.provider.localeCompare(b.provider)) })
    }
    return { from, to, bucket: "day", buckets }
  },
  usageBreakdown(scope: UsageDashboardScope, from: string, to: string, billingFor: BillingLookup): UsageBreakdownResponse {
    const ratings = new Map(ratingAggregates(scope, from, to).map((row) => [`${row.provider}\u0000${row.model}`, row]))
    let estimatedApiCost = 0, totalTokens = 0, cacheSavings = 0, requests = 0, pricedRequests = 0
    const rows = usageAggregates(scope, from, to, false).map((row) => {
      const priced = whatIfCost(row), rating = ratings.get(`${row.provider}\u0000${row.model}`)
      const tokens = tokenTotal(row); estimatedApiCost += priced.cost; totalTokens += tokens; cacheSavings += priced.savings; requests += row.requests
      if (priced.priced) pricedRequests += row.requests
      return { ...row, billing: billingFor(row.provider), estimatedApiCost: priced.cost, priced: priced.priced,
        avgRating: rating?.avgRating == null ? null : Number(rating.avgRating), ratedCount: rating?.ratedCount ?? 0,
        reworkRate: rating?.reworkRate == null ? null : Number(rating.reworkRate) }
    }).sort((a, b) => b.estimatedApiCost - a.estimatedApiCost || b.requests - a.requests || `${a.provider}/${a.model}`.localeCompare(`${b.provider}/${b.model}`))
    const rollups = new Map<string, { provider: string; billing: string | null; estimatedApiCost: number; tokens: number; share: number }>()
    for (const row of rows) {
      const provider = rollups.get(row.provider) ?? { provider: row.provider, billing: row.billing, estimatedApiCost: 0, tokens: 0, share: 0 }
      provider.estimatedApiCost += row.estimatedApiCost; provider.tokens += tokenTotal(row); rollups.set(row.provider, provider)
    }
    const providers = [...rollups.values()].map((row) => ({ ...row, share: totalTokens ? row.tokens / totalTokens : 0 }))
      .sort((a, b) => b.tokens - a.tokens || a.provider.localeCompare(b.provider))
    return { rows, totals: { estimatedApiCost, totalTokens, pricedShare: requests ? pricedRequests / requests : 0, cacheSavings }, providers }
  },
  /** The last completed lead request, used only to detect runtime handoffs. */
  latestLeadUsage(sessionId: string): { provider: string; model: string } | null {
    return backend(sessionId).query("SELECT provider,model FROM usage_log WHERE session_id=? AND role='lead' ORDER BY ts DESC,id DESC LIMIT 1").get(sessionId) as { provider: string; model: string } | null
  },
  scoreboardRows(sessionId?: string) { return db.query(`WITH usage_by_delegation AS (
    SELECT delegation_id,SUM(cost) totalCost,SUM(input_tokens+output_tokens) totalTokens FROM usage_log WHERE delegation_id IS NOT NULL GROUP BY delegation_id
  ) SELECT d.provider,d.model,d.effort,d.kind,d.seat,COUNT(*) samples,AVG(r.rating) avgRating,COUNT(r.rating) ratedCount,
    AVG(r.rework) reworkRate,SUM(u.totalCost) totalCost,SUM(COALESCE(u.totalTokens,0)) totalTokens
    FROM delegations d LEFT JOIN ratings r ON r.delegation_id=d.id LEFT JOIN usage_by_delegation u ON u.delegation_id=d.id
    ${sessionId ? "WHERE d.session_id = ?" : ""} GROUP BY d.provider,d.model,d.effort,d.kind,d.seat`).all(...(sessionId ? [sessionId] : [])) as any[] },
  getTodos(sessionId: string): TodoSnapshot[] {
    const row = backend(sessionId).query("SELECT json FROM todos WHERE session_id=?").get(sessionId) as { json: string } | null
    return row ? JSON.parse(row.json) as TodoSnapshot[] : []
  },
  putTodos(sessionId: string, todos: TodoSnapshot[]): void { backend(sessionId).query("INSERT INTO todos (session_id,json) VALUES (?,?) ON CONFLICT(session_id) DO UPDATE SET json=excluded.json").run(sessionId, JSON.stringify(todos)) },
  clearTodos(sessionId: string): void { backend(sessionId).query("DELETE FROM todos WHERE session_id=?").run(sessionId) },
  createSession(id: string, title = "New session", workspace: string = LAUNCH_WORKSPACE): void {
    const now = Date.now()
    if (isIncognitoSession(id)) {
      memoryDb.query("INSERT INTO sessions (id,title,created_at,last_activity,workspace,incognito) VALUES (?,?,?,?,?,1)").run(id,title,now,now,workspace)
      notifySessionChanged(id)
      return
    }
    stmtCreate.run(id, title, now, now, workspace)
    notifySessionChanged(id)
  },
  setIncognito(sessionId: string, allow: string[] | null): void {
    if (isIncognitoSession(sessionId)) {
      memoryDb.query("UPDATE sessions SET incognito=?, incognito_allow=? WHERE id=?").run(allow ? 1 : 0, allow ? JSON.stringify(allow) : null, sessionId)
      return
    }
    stmtIncognito.run(allow ? 1 : 0, allow ? JSON.stringify(allow) : null, sessionId)
  },
  incognitoOf(sessionId: string): { incognito: boolean; allow: string[] } {
    const row = (isIncognitoSession(sessionId) ? memoryDb.query("SELECT incognito,incognito_allow FROM sessions WHERE id=?").get(sessionId) : stmtGetIncognito.get(sessionId)) as { incognito: number; incognito_allow: string | null } | null
    let allow: string[] = []
    try { allow = row?.incognito_allow ? JSON.parse(row.incognito_allow) : [] } catch { /* corrupt legacy value */ }
    return { incognito: !!row?.incognito, allow }
  },
  incognitoRows(): Array<{ sessionId: string; incognito: number; incognitoAllow: string | null }> { return stmtIncognitoRows.all() as any },

  exists(id: string): boolean {
    return backend(id).query("SELECT 1 FROM sessions WHERE id=?").get(id) != null
  },

  isArchived(id: string): boolean {
    return db.query("SELECT 1 FROM archived_sessions WHERE id=?").get(id) != null
  },

  /** The workspace a session was created in — the authoritative scope for every
   *  run on that session (mirrors OpenCode's session-derived directory). Null for
   *  unknown sessions or pre-migration rows that somehow lack one. */
  workspaceOf(sessionId: string): string | null {
    const row = backend(sessionId).query("SELECT workspace FROM sessions WHERE id=?").get(sessionId) as { workspace: string | null } | null
    return row?.workspace ?? null
  },

  /** Persist one event and bump the session's last_activity. */
  appendEvent(sessionId: string, ev: AgentEvent): void {
    if (isIncognitoSession(sessionId)) {
      const row = memoryDb.query("SELECT COALESCE(MAX(seq),-1)+1 n FROM events WHERE session_id=?").get(sessionId) as { n: number }
      memoryDb.query("INSERT INTO events VALUES (?,?,?)").run(sessionId, row.n, JSON.stringify(ev))
      memoryDb.query("UPDATE sessions SET last_activity=? WHERE id=?").run(Date.now(), sessionId)
      notifySessionChanged(sessionId)
      return
    }
    retrySqliteTransaction(db, () => appendEventTx(sessionId, ev, Date.now()))
    notifySessionChanged(sessionId)
  },

  /** Sequence assigned to the next persisted event (for a turn boundary). */
  nextEventSeq(sessionId: string): number {
    return (backend(sessionId).query("SELECT COALESCE(MAX(seq),-1)+1 n FROM events WHERE session_id=?").get(sessionId) as { n: number }).n
  },

  startTurn(sessionId: string, userText: string, snapshotCommit: string | null): number {
    const conn=backend(sessionId); const turn = (conn.query("SELECT COALESCE(MAX(turn_index),0)+1 n FROM session_turns WHERE session_id=?").get(sessionId) as { n: number }).n
    conn.query("INSERT INTO session_turns (session_id,turn_index,start_event_seq,snapshot_commit,user_text,status,created_at) VALUES (?,?,?,?,?,'running',?)").run(sessionId, turn, this.nextEventSeq(sessionId), snapshotCommit, userText, Date.now())
    return turn
  },

  /** Attach a best-effort workspace snapshot after an asynchronously started turn.
   * This is intentionally a no-op when the turn was rewound before git finished. */
  setTurnSnapshot(sessionId: string, turn: number, snapshotCommit: string | null): void {
    backend(sessionId).query("UPDATE session_turns SET snapshot_commit=? WHERE session_id=? AND turn_index=?").run(snapshotCommit, sessionId, turn)
  },

  completeTurn(sessionId: string, turn: number, anchorCheckpointId: string | null): void {
    const conn=backend(sessionId); const last = conn.query("SELECT MAX(seq) n FROM events WHERE session_id=?").get(sessionId) as { n: number | null }
    conn.query("UPDATE session_turns SET end_event_seq=?,anchor_checkpoint_id=?,status='complete',completed_at=? WHERE session_id=? AND turn_index=?").run(last.n, anchorCheckpointId, Date.now(), sessionId, turn)
  },

  /** Read-only turn boundaries used by transcript recall filters. */
  turns(sessionId: string): Array<{ turnIndex: number; startEventSeq: number; endEventSeq: number | null }> {
    return backend(sessionId).query("SELECT turn_index AS turnIndex, start_event_seq AS startEventSeq, end_event_seq AS endEventSeq FROM session_turns WHERE session_id=? ORDER BY turn_index ASC").all(sessionId) as Array<{ turnIndex: number; startEventSeq: number; endEventSeq: number | null }>
  },

  rewindPoints(sessionId: string): RewindPoint[] {
    return (backend(sessionId).query("SELECT turn_index,created_at,user_text,snapshot_commit,anchor_checkpoint_id FROM session_turns WHERE session_id=? ORDER BY turn_index DESC").all(sessionId) as Array<{ turn_index: number; created_at: number; user_text: string; snapshot_commit: string | null; anchor_checkpoint_id: string | null }>).map((r) => ({
      turn: r.turn_index, createdAt: r.created_at, userText: r.user_text,
      complete: !!r.snapshot_commit && !!r.anchor_checkpoint_id,
    }))
  },

  turn(sessionId: string, turn: number): { startEventSeq: number; snapshotCommit: string | null; anchorCheckpointId: string | null } | null {
    const r = backend(sessionId).query("SELECT start_event_seq,snapshot_commit,anchor_checkpoint_id FROM session_turns WHERE session_id=? AND turn_index=?").get(sessionId, turn) as { start_event_seq: number; snapshot_commit: string | null; anchor_checkpoint_id: string | null } | null
    return r && { startEventSeq: r.start_event_seq, snapshotCommit: r.snapshot_commit, anchorCheckpointId: r.anchor_checkpoint_id }
  },

  rewindTranscript(sessionId: string, turn: number, startEventSeq: number): void {
    const conn=backend(sessionId); conn.query("DELETE FROM events WHERE session_id=? AND seq>=?").run(sessionId,startEventSeq); conn.query("DELETE FROM session_turns WHERE session_id=? AND turn_index>=?").run(sessionId,turn); conn.query("DELETE FROM session_compaction_artifacts WHERE session_id=?").run(sessionId)
  },

  history(sessionId: string): AgentEvent[] {
    if (isIncognitoSession(sessionId)) return (memoryDb.query("SELECT json FROM events WHERE session_id=? ORDER BY seq").all(sessionId) as { json: string }[]).map((r) => JSON.parse(r.json) as AgentEvent)
    const rows = stmtHistory.all(sessionId) as { json: string }[]
    return rows.map((r) => JSON.parse(r.json) as AgentEvent)
  },

  /** Read-only durable transcript rows, retaining their event sequence numbers.
   * Used by recall; unlike rewind, this never mutates events. */
  historyWithSeq(sessionId: string): Array<{ seq: number; event: AgentEvent }> {
    const conn = isIncognitoSession(sessionId) ? memoryDb : db
    const rows = (isIncognitoSession(sessionId)
      ? conn.query("SELECT seq, json FROM events WHERE session_id=? ORDER BY seq ASC").all(sessionId)
      : stmtHistoryWithSeq.all(sessionId)) as Array<{ seq: number; json: string }>
    return rows.map((row) => ({ seq: row.seq, event: JSON.parse(row.json) as AgentEvent }))
  },

  /** Read a bounded transcript tail without materializing older event rows. */
  recentHistoryWithSeq(sessionId: string, limit: number): Array<{ seq: number; event: AgentEvent }> {
    const boundedLimit = Math.max(0, Math.floor(limit))
    if (boundedLimit === 0) return []
    const rows = backend(sessionId).query(recentHistorySql).all(sessionId, boundedLimit) as Array<{ seq: number; json: string }>
    return rows.reverse().map((row) => ({ seq: row.seq, event: JSON.parse(row.json) as AgentEvent }))
  },

  /** Persisted run-status markers only; unlike history this does not materialize
   * message deltas, tool output, or other transcript events. */
  statusEvents(sessionId: string): AgentEvent[] {
    const rows = backend(sessionId).query(statusEventsSql).all(sessionId) as Array<{ json: string }>
    return rows.map((row) => JSON.parse(row.json) as AgentEvent)
  },

  titleOf(sessionId: string): string | null {
    const row = stmtTitleOf.get(sessionId) as { title: string } | null
    return row?.title ?? null
  },

  /** The MAIN thread's most recent completed assistant message, reassembled
   *  from persisted delta events. Used by send_to_session's wait_for_reply to
   *  hand the target's answer back to the sender. */
  lastAssistantText(sessionId: string): string | null {
    const conn = backend(sessionId)
    const pageSize = 256
    let before: number | undefined
    let active: string[] | null = null

    // Walk backwards so the first non-blank message found is the same one the
    // forward implementation would have returned, without loading old rows.
    for (;;) {
      const rows = (before === undefined
        ? conn.query("SELECT seq, json FROM events WHERE session_id=? ORDER BY seq DESC LIMIT ?").all(sessionId, pageSize)
        : conn.query("SELECT seq, json FROM events WHERE session_id=? AND seq<? ORDER BY seq DESC LIMIT ?").all(sessionId, before, pageSize)) as Array<{ seq: number; json: string }>
      if (!rows.length) break
      before = rows[rows.length - 1].seq
      for (const row of rows) {
        const ev = JSON.parse(row.json) as AgentEvent
        if ("threadId" in ev && ev.threadId) continue // child threads don't count
        if (ev.type === "message.end") {
          if (active === null) active = []
        } else if (ev.type === "message.delta") {
          if (active === null) active = []
          active.unshift(ev.text)
        } else if (ev.type === "message.start") {
          if (active !== null) {
            const text = active.join("")
            if (text.trim()) return text
            active = null
          }
        }
      }
    }
    // A stream cut off mid-message still counts (message.end may be missing).
    if (active !== null) {
      const text = active.join("")
      return text.trim() ? text : null
    }
    return null
  },

  /** Set a session title once (first user message makes a nice resume label). */
  setTitleIfDefault(sessionId: string, title: string): void {
    const trimmed = title.trim().slice(0, 80)
    if (trimmed) {
      const result = backend(sessionId).query("UPDATE sessions SET title=? WHERE id=? AND title='New session'").run(trimmed, sessionId)
      if (result.changes) notifySessionChanged(sessionId)
    }
  },

  /** Replace a session title unconditionally. */
  setTitle(sessionId: string, title: string): void {
    backend(sessionId).query("UPDATE sessions SET title=?, title_custom=1 WHERE id=?").run(title, sessionId)
    notifySessionChanged(sessionId)
  },

  /** Replace an automatically generated/default title, but never a user rename. */
  setAutoTitle(sessionId: string, title: string): boolean {
    const clean = title.trim().slice(0, 80)
    if (!clean || isIncognitoSession(sessionId)) return false
    const result = backend(sessionId).query("UPDATE sessions SET title=? WHERE id=? AND title_custom=0").run(clean, sessionId)
    if (result.changes) notifySessionChanged(sessionId)
    return result.changes > 0
  },

  canAutoTitle(sessionId: string): boolean {
    const row = backend(sessionId).query("SELECT title_custom FROM sessions WHERE id=?").get(sessionId) as { title_custom: number } | null
    return row != null && row.title_custom === 0
  },

  /** Compact shell lookup: row only, never hydrates transcript events. */
  summary(sessionId: string): SessionSummary | null {
    const row = backend(sessionId).query("SELECT id,title,created_at,last_activity,workspace,incognito FROM sessions WHERE id=?").get(sessionId) as { id: string; title: string; created_at: number; last_activity: number; workspace: string; incognito: number } | null
    if (row) return { sessionId: row.id, title: row.title, createdAt: row.created_at, lastActivity: row.last_activity, workspace: row.workspace, incognito: !!row.incognito }
    const archived = db.query("SELECT id,title,created_at,last_activity,workspace FROM archived_sessions WHERE id=?").get(sessionId) as { id: string; title: string; created_at: number; last_activity: number; workspace: string } | null
    return archived && { sessionId: archived.id, title: archived.title, createdAt: archived.created_at, lastActivity: archived.last_activity, workspace: archived.workspace, archived: true } as SessionSummary
  },

  /** Unbounded compact row query for the mobile cross-repository shell. */
  listShell(): SessionSummary[] {
    const rows = [...db.query("SELECT id,title,created_at,last_activity,workspace,incognito,0 archived FROM sessions").all(), ...memoryDb.query("SELECT id,title,created_at,last_activity,workspace,incognito,0 archived FROM sessions").all(), ...db.query("SELECT id,title,created_at,last_activity,workspace,0 incognito,1 archived FROM archived_sessions").all()] as Array<{ id: string; title: string; created_at: number; last_activity: number; workspace: string; incognito: number; archived: number }>
    const deduped = new Map<string, SessionSummary>()
    for (const row of rows) deduped.set(row.id, { sessionId: row.id, title: row.title, createdAt: row.created_at, lastActivity: row.last_activity, workspace: row.workspace, incognito: !!row.incognito, ...(row.archived ? { archived: true } : {}) } as SessionSummary)
    return [...deduped.values()].sort((a, b) => b.lastActivity - a.lastActivity)
  },

  /** List sessions, optionally scoped to one workspace (repo). Omit `workspace`
   *  to list across all repos. */
  list(workspace?: string): SessionSummary[] {
    const rows = (workspace ? stmtListByWorkspace.all(workspace) : stmtListAll.all()) as {
      id: string
      title: string
      created_at: number
      last_activity: number
      workspace: string
    }[]
    const memoryRows = (workspace ? memoryDb.query("SELECT id,title,created_at,last_activity,workspace FROM sessions WHERE workspace=?").all(workspace) : memoryDb.query("SELECT id,title,created_at,last_activity,workspace FROM sessions").all()) as typeof rows
    const archivedRows = (workspace ? db.query("SELECT id,title,created_at,last_activity,workspace FROM archived_sessions WHERE workspace=?").all(workspace) : db.query("SELECT id,title,created_at,last_activity,workspace FROM archived_sessions").all()) as typeof rows
    return [...rows, ...memoryRows, ...archivedRows].sort((a,b) => b.last_activity - a.last_activity).slice(0, 100).map((r) => ({
      sessionId: r.id,
      title: r.title,
      createdAt: r.created_at,
      lastActivity: r.last_activity,
      workspace: r.workspace,
      incognito: isIncognitoSession(r.id),
      ...(archivedRows.some((a) => a.id === r.id) ? { archived: true } : {}),
    } as SessionSummary))
  },

  /**
   * List sessions across a SET of workspaces — a repository plus its linked git
   * worktrees, so a `/fork --worktree` child still appears under the repo it was
   * cut from instead of vanishing from every tab.
   *
   * Deliberately additive: `list` keeps its exact-match single-workspace query
   * for every other caller. An EMPTY set returns nothing rather than falling
   * back to "all sessions" — a caller whose repo could not be resolved must get
   * an empty tab, never every session on the machine.
   *
   * Paths are bound as parameters (only the placeholder count is interpolated),
   * so a workspace path can never be SQL.
   */
  listByWorkspaces(workspaces: readonly string[]): SessionSummary[] {
    const paths = [...new Set(workspaces.filter((path) => typeof path === "string" && path.length > 0))]
    if (paths.length === 0) return []
    const holes = paths.map(() => "?").join(",")
    const columns = "SELECT id,title,created_at,last_activity,workspace FROM"
    const tail = `WHERE workspace IN (${holes}) ORDER BY last_activity DESC LIMIT 100`
    const rows = db.query(`${columns} sessions ${tail}`).all(...paths) as {
      id: string
      title: string
      created_at: number
      last_activity: number
      workspace: string
    }[]
    const memoryRows = memoryDb.query(`${columns} sessions ${tail}`).all(...paths) as typeof rows
    const archivedRows = db.query(`${columns} archived_sessions ${tail}`).all(...paths) as typeof rows
    return [...rows, ...memoryRows, ...archivedRows].sort((a, b) => b.last_activity - a.last_activity).slice(0, 100).map((r) => ({
      sessionId: r.id,
      title: r.title,
      createdAt: r.created_at,
      lastActivity: r.last_activity,
      workspace: r.workspace,
      incognito: isIncognitoSession(r.id),
      ...(archivedRows.some((a) => a.id === r.id) ? { archived: true } : {}),
    } as SessionSummary))
  },

  /**
   * Workspace paths of `/fork --worktree` children whose PARENT session lives in
   * one of `parentWorkspaces`.
   *
   * This is the authoritative link for worktrees Chunky itself created, and it
   * deliberately does not go through git: the child's workspace was recorded
   * exactly as the fork wrote it, whereas `git worktree list` reports the
   * canonicalized path. Where a path component is a symlink those two spellings
   * differ, and matching on git's answer alone would silently drop the child
   * from its parent repo's tab. Reading the recorded path instead cannot miss.
   */
  worktreeWorkspacesUnder(parentWorkspaces: readonly string[]): string[] {
    const paths = [...new Set(parentWorkspaces.filter((path) => typeof path === "string" && path.length > 0))]
    if (paths.length === 0) return []
    const holes = paths.map(() => "?").join(",")
    const rows = db.query(
      `SELECT w.path AS path FROM session_workspaces w
       JOIN sessions s ON s.id = w.parent_session_id
       WHERE w.kind = 'worktree' AND s.workspace IN (${holes})`,
    ).all(...paths) as { path: string }[]
    return [...new Set(rows.map((row) => row.path).filter((path) => typeof path === "string" && path.length > 0))]
  },

  // ---- Goal mode (one goal per session, persisted so it survives restart) ----

  getGoal(sessionId: string): Goal | null {
    const row = backend(sessionId).query("SELECT * FROM goals WHERE session_id=?").get(sessionId) as GoalRow | null
    return row ? rowToGoal(row) : null
  },

  /** Create-or-replace the session's goal (INSERT ... ON CONFLICT). */
  putGoal(goal: Goal): void {
    backend(goal.sessionId).query(`INSERT INTO goals (session_id,objective,status,mode,created_at,updated_at,turns,max_turns,evidence,blocked_reason) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET objective=excluded.objective,status=excluded.status,mode=excluded.mode,updated_at=excluded.updated_at,turns=excluded.turns,max_turns=excluded.max_turns,evidence=excluded.evidence,blocked_reason=excluded.blocked_reason`).run(
      goal.sessionId, goal.objective, goal.status, goal.mode, goal.createdAt, goal.updatedAt, goal.turns, goal.maxTurns, goal.evidence ?? null, goal.blockedReason ?? null)
    /* stmtUpsertGoal.run({
      $session_id: goal.sessionId,
      $objective: goal.objective,
      $status: goal.status,
      $mode: goal.mode ?? "direct",
      $created_at: goal.createdAt,
      $updated_at: goal.updatedAt,
      $turns: goal.turns,
      $max_turns: goal.maxTurns,
      $evidence: goal.evidence ?? null,
      $blocked_reason: goal.blockedReason ?? null,
    }) */
  },

  /** Merge-patch the session's goal; no-op if none exists. Returns the new goal. */
  updateGoal(sessionId: string, patch: Partial<Omit<Goal, "sessionId" | "createdAt">>): Goal | null {
    const current = this.getGoal(sessionId)
    if (!current) return null
    const next: Goal = { ...current, ...patch, updatedAt: Date.now() }
    this.putGoal(next)
    return next
  },

  clearGoal(sessionId: string): void {
    backend(sessionId).query("DELETE FROM goals WHERE session_id=?").run(sessionId)
  },

  // ---- Pinned model selection (optional; most sessions follow the global one) ----

  /** The session's pinned model selection, or null to follow the global active
   *  selection. Set at ship time so a goal-orchestrator session keeps its model
   *  even as the user's /model choice moves on. */
  pinnedSelectionOf(sessionId: string): PinnedSelection | null {
    const row = backend(sessionId).query("SELECT selection FROM sessions WHERE id=?").get(sessionId) as { selection: string | null } | null
    if (!row?.selection) return null
    try {
      const parsed = JSON.parse(row.selection) as PinnedSelection
      return parsed && typeof parsed.provider === "string" ? parsed : null
    } catch {
      return null
    }
  },

  /** Pin (or with null, unpin) the session's model selection. */
  pinSelection(sessionId: string, selection: PinnedSelection | null): void {
    const conn = backend(sessionId)
    const previous = conn.query("SELECT selection FROM sessions WHERE id=?").get(sessionId) as { selection: string | null } | null
    conn.query("UPDATE sessions SET selection=? WHERE id=?").run(selection ? JSON.stringify(selection) : null, sessionId)
    try {
      const old = previous?.selection ? JSON.parse(previous.selection) as PinnedSelection : null
      if (old?.provider !== selection?.provider || old?.model !== selection?.model) conn.query("DELETE FROM session_compaction_artifacts WHERE session_id=?").run(sessionId)
    } catch { conn.query("DELETE FROM session_compaction_artifacts WHERE session_id=?").run(sessionId) }
  },

  /** Complete mode pinned to this session, or null when it follows legacy
   * selection/global configuration. Corrupt values fail closed to inheritance. */
  agentConfigOf(sessionId: string): SessionAgentConfig | null {
    const row = backend(sessionId).query("SELECT agent_config FROM sessions WHERE id=?").get(sessionId) as { agent_config: string | null } | null
    if (!row?.agent_config) return null
    try {
      const parsed = JSON.parse(row.agent_config) as SessionAgentConfig
      return parsed && typeof parsed.activeMode === "string" && typeof parsed.selection?.provider === "string" ? parsed : null
    } catch { return null }
  },

  setAgentConfig(sessionId: string, config: SessionAgentConfig | null): void {
    const conn = backend(sessionId)
    const previous = this.agentConfigOf(sessionId)
    conn.query("UPDATE sessions SET agent_config=? WHERE id=?").run(config ? JSON.stringify(config) : null, sessionId)
    if (previous?.selection.provider !== config?.selection.provider || previous?.selection.model !== config?.selection.model) {
      conn.query("DELETE FROM session_compaction_artifacts WHERE session_id=?").run(sessionId)
    }
  },

  setCompactionArtifact(sessionId: string, artifact: { provider: string; model: string; replacementHistory: unknown[]; boundary: string; usage?: unknown }): void {
    backend(sessionId).query(`INSERT INTO session_compaction_artifacts (session_id,provider,model,replacement_history_json,boundary,created_at,usage_json) VALUES (?,?,?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET provider=excluded.provider,model=excluded.model,replacement_history_json=excluded.replacement_history_json,boundary=excluded.boundary,created_at=excluded.created_at,usage_json=excluded.usage_json`).run(sessionId, artifact.provider, artifact.model, JSON.stringify(artifact.replacementHistory), artifact.boundary, Date.now(), artifact.usage == null ? null : JSON.stringify(artifact.usage))
  },
  getCompactionArtifact(sessionId: string): { provider: string; model: string; replacementHistory: unknown[]; boundary: string; createdAt: number; usage?: unknown } | null {
    const row = backend(sessionId).query("SELECT provider,model,replacement_history_json,boundary,created_at,usage_json FROM session_compaction_artifacts WHERE session_id=?").get(sessionId) as any
    if (!row) return null
    try { return { provider: row.provider, model: row.model, replacementHistory: JSON.parse(row.replacement_history_json), boundary: row.boundary, createdAt: row.created_at, usage: row.usage_json ? JSON.parse(row.usage_json) : undefined } } catch { return null }
  },
  clearCompactionArtifact(sessionId: string): void { backend(sessionId).query("DELETE FROM session_compaction_artifacts WHERE session_id=?").run(sessionId) },
  /** Clear native artifacts for sessions following a changed global selection.
   * Pinned sessions retain their own compatible native history. */
  invalidateGlobalCompactionArtifacts(provider: string, model: string): void {
    db.query(`DELETE FROM session_compaction_artifacts
      WHERE session_id IN (SELECT id FROM sessions WHERE selection IS NULL AND agent_config IS NULL)
        AND NOT (provider=? AND model=?)`).run(provider, model)
  },

  /** Session-local sidekick patch, or null when this session follows global
   * sidekick settings exactly. Corrupt legacy values are ignored safely. */
  sidekickOverrideOf(sessionId: string): SessionSidekickOverride | null {
    const row = backend(sessionId).query("SELECT sidekick FROM sessions WHERE id=?").get(sessionId) as { sidekick: string | null } | null
    if (!row?.sidekick) return null
    try {
      const parsed = JSON.parse(row.sidekick) as SessionSidekickOverride
      return parsed && typeof parsed === "object" ? parsed : null
    } catch {
      return null
    }
  },

  /** Persist (or clear) this session's sidekick patch. */
  setSidekickOverride(sessionId: string, override: SessionSidekickOverride | null): void {
    backend(sessionId).query("UPDATE sessions SET sidekick=? WHERE id=?").run(override ? JSON.stringify(override) : null, sessionId)
  },

  /** Atomically materialize a current-state child. Snapshot commits remain
   * reachable by their parent refs; copied turn metadata lets the child rewind. */
  forkSession(childId: string, parentId: string, workspace: string, kind: "normal" | "worktree", directive?: string, worktree?: { gitCommonDir: string; branch: string }): void {
    if (isIncognitoSession(parentId)) {
      throw new Error("cannot fork an incognito session")
    }
    const parent = db.query("SELECT title, selection, sidekick, agent_config FROM sessions WHERE id = ?").get(parentId) as { title: string; selection: string | null; sidekick: string | null; agent_config: string | null }
    const now = Date.now()
    retrySqliteTransaction(db, () => {
      stmtCreate.run(childId, `${parent.title} · fork`, now, now, workspace)
      db.query("DELETE FROM session_compaction_artifacts WHERE session_id=?").run(childId)
      if (parent.selection) stmtPinSelection.run(parent.selection, childId)
      if (parent.sidekick) db.query("UPDATE sessions SET sidekick=? WHERE id=?").run(parent.sidekick, childId)
      if (parent.agent_config) db.query("UPDATE sessions SET agent_config=? WHERE id=?").run(parent.agent_config, childId)
      stmtCopyEvents.run(childId, parentId)
      stmtCopyTurns.run(childId, parentId)
      const last = stmtLastSeq.get(parentId) as { n: number | null }
      stmtBranch.run(childId, parentId, last.n ?? -1, kind, directive ?? null, now)
      if (kind === "worktree" && worktree) stmtWorktree.run(childId, workspace, worktree.gitCommonDir, worktree.branch, parentId, now)
    })
    notifySessionChanged(childId)
  },

  forkBranchOf(sessionId: string): { parentSessionId: string; kind: "normal" | "worktree"; directive: string | null } | null {
    const row = stmtBranchOf.get(sessionId) as { parent_session_id: string; kind: "normal" | "worktree"; directive: string | null } | null
    return row && { parentSessionId: row.parent_session_id, kind: row.kind, directive: row.directive }
  },

  workspaceMetadataOf(sessionId: string): { path: string; branch: string; parentSessionId: string } | null {
    const row = stmtWorkspaceMeta.get(sessionId) as { path: string; branch: string; parent_session_id: string } | null
    return row && { path: row.path, branch: row.branch, parentSessionId: row.parent_session_id }
  },
}
