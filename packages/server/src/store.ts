// Durable session + event store on bun:sqlite (native, no build step).
// Makes transcripts survive a server restart, so reconnecting to a sessionId
// replays the full prior run — i.e. "resume". Kept deliberately tiny.
import { openSqlite, retrySqliteTransaction } from "./sqlite.ts"
import type { AgentEvent, RewindPoint, SessionSummary } from "@chunky/protocol"
import type { Goal } from "./goal.ts"
import type { TodoSnapshot } from "./todos.ts"
import type { AgentSelection } from "./providers/registry.ts"
import { LAUNCH_WORKSPACE } from "./workspace.ts"
import { pricingFor } from "./providers/models-catalog.ts"
import { isIncognitoSession } from "./incognito.ts"

/** A session's pinned model choice (type-only alias — the import is erased, so
 *  the store keeps zero runtime provider dependencies). */
export type PinnedSelection = AgentSelection
export type UsageLedgerInput = {
  sessionId: string; threadId?: string; role: "lead" | "sidekick" | "advisor" | "child"
  provider: string; model: string; effort?: string | null; delegationId?: string | null
  inputTokens?: number; outputTokens?: number; reasoningTokens?: number
  cacheReadTokens?: number; cacheWriteTokens?: number; ts?: number
}
export type DelegationInput = { id: string; sessionId: string; kind: "sidekick" | "child" | "workflow_agent"; seat?: string; provider: string; model: string; effort?: string; briefSnippet: string }

const DB_PATH = process.env.CHUNKY_DB || "chunky.db"
const db = openSqlite(DB_PATH)
// Incognito data is deliberately process-local. Keep a separate connection so
// accidental SQL against the durable database cannot expose it.
const memoryDb = openSqlite(":memory:")
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id            TEXT PRIMARY KEY,
    title         TEXT NOT NULL DEFAULT 'New session',
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
    reason TEXT NOT NULL, judge_provider TEXT NOT NULL, judge_model TEXT NOT NULL, ts INTEGER NOT NULL
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
  if (!cols.some((c) => c.name === "incognito")) db.exec("ALTER TABLE sessions ADD COLUMN incognito INTEGER NOT NULL DEFAULT 0")
  if (!cols.some((c) => c.name === "incognito_allow")) db.exec("ALTER TABLE sessions ADD COLUMN incognito_allow TEXT")
}

// Mirror the complete, migrated durable schema exactly. Incognito rows never
// use the durable connection; this copy only defines the in-process database.
for (const row of db.query("SELECT sql FROM sqlite_master WHERE type='table' AND sql IS NOT NULL").all() as Array<{ sql: string }>) memoryDb.exec(row.sql)
function backend(sessionId: string) { return isIncognitoSession(sessionId) ? memoryDb : db }

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
  rateDelegation(id: string, rating: number, rework: boolean, reason: string, judge: AgentSelection): void { for (const conn of [db, memoryDb]) conn.query("INSERT INTO ratings (delegation_id,rating,rework,reason,judge_provider,judge_model,ts) VALUES (?,?,?,?,?,?,?) ON CONFLICT(delegation_id) DO UPDATE SET rating=excluded.rating,rework=excluded.rework,reason=excluded.reason,judge_provider=excluded.judge_provider,judge_model=excluded.judge_model,ts=excluded.ts").run(...([id,rating,rework?1:0,reason,judge.provider,judge.model,Date.now()] as any)) },
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
  scoreboardRows(sessionId?: string) { return db.query(`SELECT d.provider,d.model,d.effort,d.kind,COUNT(*) samples,AVG(r.rating) avgRating,COUNT(r.rating) ratedCount,AVG(r.rework) reworkRate,SUM(u.cost) totalCost,SUM(COALESCE(u.input_tokens,0)+COALESCE(u.output_tokens,0)) totalTokens FROM delegations d LEFT JOIN ratings r ON r.delegation_id=d.id LEFT JOIN usage_log u ON u.delegation_id=d.id ${sessionId ? "WHERE d.session_id = ?" : ""} GROUP BY d.provider,d.model,d.effort,d.kind`).all(...(sessionId ? [sessionId] : [])) as any[] },
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
      return
    }
    stmtCreate.run(id, title, now, now, workspace)
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
      return
    }
    retrySqliteTransaction(db, () => appendEventTx(sessionId, ev, Date.now()))
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

  completeTurn(sessionId: string, turn: number, anchorCheckpointId: string | null): void {
    const conn=backend(sessionId); const last = conn.query("SELECT MAX(seq) n FROM events WHERE session_id=?").get(sessionId) as { n: number | null }
    conn.query("UPDATE session_turns SET end_event_seq=?,anchor_checkpoint_id=?,status='complete',completed_at=? WHERE session_id=? AND turn_index=?").run(last.n, anchorCheckpointId, Date.now(), sessionId, turn)
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
    const conn=backend(sessionId); conn.query("DELETE FROM events WHERE session_id=? AND seq>=?").run(sessionId,startEventSeq); conn.query("DELETE FROM session_turns WHERE session_id=? AND turn_index>=?").run(sessionId,turn)
  },

  history(sessionId: string): AgentEvent[] {
    if (isIncognitoSession(sessionId)) return (memoryDb.query("SELECT json FROM events WHERE session_id=? ORDER BY seq").all(sessionId) as { json: string }[]).map((r) => JSON.parse(r.json) as AgentEvent)
    const rows = stmtHistory.all(sessionId) as { json: string }[]
    return rows.map((r) => JSON.parse(r.json) as AgentEvent)
  },

  titleOf(sessionId: string): string | null {
    const row = stmtTitleOf.get(sessionId) as { title: string } | null
    return row?.title ?? null
  },

  /** The MAIN thread's most recent completed assistant message, reassembled
   *  from persisted delta events. Used by send_to_session's wait_for_reply to
   *  hand the target's answer back to the sender. */
  lastAssistantText(sessionId: string): string | null {
    const history = this.history(sessionId)
    let current: string | null = null
    let last: string | null = null
    for (const ev of history) {
      if ("threadId" in ev && ev.threadId) continue // child threads don't count
      if (ev.type === "message.start") current = ""
      else if (ev.type === "message.delta") current = (current ?? "") + ev.text
      else if (ev.type === "message.end") {
        if (current && current.trim()) last = current
        current = null
      }
    }
    // A stream cut off mid-message still counts (message.end may be missing).
    if (current && current.trim()) last = current
    return last
  },

  /** Set a session title once (first user message makes a nice resume label). */
  setTitleIfDefault(sessionId: string, title: string): void {
    const trimmed = title.trim().slice(0, 80)
    if (trimmed) backend(sessionId).query("UPDATE sessions SET title=? WHERE id=?").run(trimmed, sessionId)
  },

  /** Replace a session title unconditionally. */
  setTitle(sessionId: string, title: string): void {
    backend(sessionId).query("UPDATE sessions SET title=? WHERE id=?").run(title, sessionId)
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
    return [...rows, ...memoryRows].sort((a,b) => b.last_activity - a.last_activity).slice(0, 100).map((r) => ({
      sessionId: r.id,
      title: r.title,
      createdAt: r.created_at,
      lastActivity: r.last_activity,
      workspace: r.workspace,
      incognito: isIncognitoSession(r.id),
    }))
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
    backend(sessionId).query("UPDATE sessions SET selection=? WHERE id=?").run(selection ? JSON.stringify(selection) : null, sessionId)
  },

  /** Atomically materialize a current-state child. Snapshot commits remain
   * reachable by their parent refs; copied turn metadata lets the child rewind. */
  forkSession(childId: string, parentId: string, workspace: string, kind: "normal" | "worktree", directive?: string, worktree?: { gitCommonDir: string; branch: string }): void {
    if (isIncognitoSession(parentId)) {
      throw new Error("cannot fork an incognito session")
    }
    const parent = db.query("SELECT title, selection FROM sessions WHERE id = ?").get(parentId) as { title: string; selection: string | null }
    const now = Date.now()
    retrySqliteTransaction(db, () => {
      stmtCreate.run(childId, `${parent.title} · fork`, now, now, workspace)
      if (parent.selection) stmtPinSelection.run(parent.selection, childId)
      stmtCopyEvents.run(childId, parentId)
      stmtCopyTurns.run(childId, parentId)
      const last = stmtLastSeq.get(parentId) as { n: number | null }
      stmtBranch.run(childId, parentId, last.n ?? -1, kind, directive ?? null, now)
      if (kind === "worktree" && worktree) stmtWorktree.run(childId, workspace, worktree.gitCommonDir, worktree.branch, parentId, now)
    })
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
