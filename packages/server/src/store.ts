// Durable session + event store on bun:sqlite (native, no build step).
// Makes transcripts survive a server restart, so reconnecting to a sessionId
// replays the full prior run — i.e. "resume". Kept deliberately tiny.
import { Database } from "bun:sqlite"
import type { AgentEvent, SessionSummary } from "@chunky/protocol"
import type { Goal } from "./goal.ts"
import { LAUNCH_WORKSPACE } from "./workspace.ts"

const DB_PATH = process.env.CHUNKY_DB || "chunky.db"
const db = new Database(DB_PATH)
db.exec("PRAGMA journal_mode = WAL;")
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
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    turns         INTEGER NOT NULL DEFAULT 0,
    max_turns     INTEGER NOT NULL,
    evidence      TEXT,
    blocked_reason TEXT
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
}

const stmtCreate = db.query(
  "INSERT INTO sessions (id, title, created_at, last_activity, workspace) VALUES (?, ?, ?, ?, ?)",
)
const stmtTouch = db.query("UPDATE sessions SET last_activity = ? WHERE id = ?")
const stmtTitle = db.query("UPDATE sessions SET title = ? WHERE id = ?")
const stmtExists = db.query("SELECT 1 FROM sessions WHERE id = ?")
const stmtListAll = db.query(
  "SELECT id, title, created_at, last_activity FROM sessions ORDER BY last_activity DESC LIMIT 100",
)
const stmtListByWorkspace = db.query(
  "SELECT id, title, created_at, last_activity FROM sessions WHERE workspace = ? ORDER BY last_activity DESC LIMIT 100",
)
const stmtWorkspace = db.query("SELECT workspace FROM sessions WHERE id = ?")
const stmtNextSeq = db.query("SELECT COALESCE(MAX(seq), -1) + 1 AS n FROM events WHERE session_id = ?")
const stmtInsertEvent = db.query("INSERT INTO events (session_id, seq, json) VALUES (?, ?, ?)")
const stmtHistory = db.query("SELECT json FROM events WHERE session_id = ? ORDER BY seq ASC")
const stmtGetGoal = db.query("SELECT * FROM goals WHERE session_id = ?")
const stmtUpsertGoal = db.query(
  `INSERT INTO goals (session_id, objective, status, created_at, updated_at, turns, max_turns, evidence, blocked_reason)
   VALUES ($session_id, $objective, $status, $created_at, $updated_at, $turns, $max_turns, $evidence, $blocked_reason)
   ON CONFLICT(session_id) DO UPDATE SET
     objective = $objective, status = $status, updated_at = $updated_at, turns = $turns,
     max_turns = $max_turns, evidence = $evidence, blocked_reason = $blocked_reason`,
)
const stmtClearGoal = db.query("DELETE FROM goals WHERE session_id = ?")

interface GoalRow {
  session_id: string
  objective: string
  status: string
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    turns: row.turns,
    maxTurns: row.max_turns,
    evidence: row.evidence ?? undefined,
    blockedReason: row.blocked_reason ?? undefined,
  }
}

export const Store = {
  createSession(id: string, title = "New session", workspace: string = LAUNCH_WORKSPACE): void {
    const now = Date.now()
    stmtCreate.run(id, title, now, now, workspace)
  },

  exists(id: string): boolean {
    return stmtExists.get(id) != null
  },

  /** The workspace a session was created in — the authoritative scope for every
   *  run on that session (mirrors OpenCode's session-derived directory). Null for
   *  unknown sessions or pre-migration rows that somehow lack one. */
  workspaceOf(sessionId: string): string | null {
    const row = stmtWorkspace.get(sessionId) as { workspace: string | null } | null
    return row?.workspace ?? null
  },

  /** Persist one event and bump the session's last_activity. */
  appendEvent(sessionId: string, ev: AgentEvent): void {
    const row = stmtNextSeq.get(sessionId) as { n: number }
    stmtInsertEvent.run(sessionId, row.n, JSON.stringify(ev))
    stmtTouch.run(Date.now(), sessionId)
  },

  history(sessionId: string): AgentEvent[] {
    const rows = stmtHistory.all(sessionId) as { json: string }[]
    return rows.map((r) => JSON.parse(r.json) as AgentEvent)
  },

  /** Set a session title once (first user message makes a nice resume label). */
  setTitleIfDefault(sessionId: string, title: string): void {
    const trimmed = title.trim().slice(0, 80)
    if (trimmed) stmtTitle.run(trimmed, sessionId)
  },

  /** List sessions, optionally scoped to one workspace (repo). Omit `workspace`
   *  to list across all repos. */
  list(workspace?: string): SessionSummary[] {
    const rows = (workspace ? stmtListByWorkspace.all(workspace) : stmtListAll.all()) as {
      id: string
      title: string
      created_at: number
      last_activity: number
    }[]
    return rows.map((r) => ({
      sessionId: r.id,
      title: r.title,
      createdAt: r.created_at,
      lastActivity: r.last_activity,
    }))
  },

  // ---- Goal mode (one goal per session, persisted so it survives restart) ----

  getGoal(sessionId: string): Goal | null {
    const row = stmtGetGoal.get(sessionId) as GoalRow | null
    return row ? rowToGoal(row) : null
  },

  /** Create-or-replace the session's goal (INSERT ... ON CONFLICT). */
  putGoal(goal: Goal): void {
    stmtUpsertGoal.run({
      $session_id: goal.sessionId,
      $objective: goal.objective,
      $status: goal.status,
      $created_at: goal.createdAt,
      $updated_at: goal.updatedAt,
      $turns: goal.turns,
      $max_turns: goal.maxTurns,
      $evidence: goal.evidence ?? null,
      $blocked_reason: goal.blockedReason ?? null,
    })
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
    stmtClearGoal.run(sessionId)
  },
}
