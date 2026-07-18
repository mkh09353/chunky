// Durable session + event store on bun:sqlite (native, no build step).
// Makes transcripts survive a server restart, so reconnecting to a sessionId
// replays the full prior run — i.e. "resume". Kept deliberately tiny.
import { openSqlite, retrySqliteTransaction } from "./sqlite.ts"
import type { AgentEvent, RewindPoint, SessionSummary } from "@chunky/protocol"
import type { Goal } from "./goal.ts"
import type { TodoSnapshot } from "./todos.ts"
import type { AgentSelection } from "./providers/registry.ts"
import { LAUNCH_WORKSPACE } from "./workspace.ts"

/** A session's pinned model choice (type-only alias — the import is erased, so
 *  the store keeps zero runtime provider dependencies). */
export type PinnedSelection = AgentSelection

const DB_PATH = process.env.CHUNKY_DB || "chunky.db"
const db = openSqlite(DB_PATH)
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
  "INSERT INTO sessions (id, title, created_at, last_activity, workspace) VALUES (?, ?, ?, ?, ?)",
)
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
  getTodos(sessionId: string): TodoSnapshot[] {
    const row = stmtGetTodos.get(sessionId) as { json: string } | null
    return row ? JSON.parse(row.json) as TodoSnapshot[] : []
  },
  putTodos(sessionId: string, todos: TodoSnapshot[]): void { stmtPutTodos.run(sessionId, JSON.stringify(todos)) },
  clearTodos(sessionId: string): void { stmtClearTodos.run(sessionId) },
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
    retrySqliteTransaction(db, () => appendEventTx(sessionId, ev, Date.now()))
  },

  /** Sequence assigned to the next persisted event (for a turn boundary). */
  nextEventSeq(sessionId: string): number {
    return (stmtNextSeq.get(sessionId) as { n: number }).n
  },

  startTurn(sessionId: string, userText: string, snapshotCommit: string | null): number {
    const turn = (stmtNextTurn.get(sessionId) as { n: number }).n
    stmtInsertTurn.run(sessionId, turn, this.nextEventSeq(sessionId), snapshotCommit, userText, Date.now())
    return turn
  },

  completeTurn(sessionId: string, turn: number, anchorCheckpointId: string | null): void {
    const last = stmtLastSeq.get(sessionId) as { n: number | null }
    stmtCompleteTurn.run(last.n, anchorCheckpointId, Date.now(), sessionId, turn)
  },

  rewindPoints(sessionId: string): RewindPoint[] {
    return (stmtPoints.all(sessionId) as Array<{ turn_index: number; created_at: number; user_text: string; snapshot_commit: string | null; anchor_checkpoint_id: string | null }>).map((r) => ({
      turn: r.turn_index, createdAt: r.created_at, userText: r.user_text,
      complete: !!r.snapshot_commit && !!r.anchor_checkpoint_id,
    }))
  },

  turn(sessionId: string, turn: number): { startEventSeq: number; snapshotCommit: string | null; anchorCheckpointId: string | null } | null {
    const r = stmtTurn.get(sessionId, turn) as { start_event_seq: number; snapshot_commit: string | null; anchor_checkpoint_id: string | null } | null
    return r && { startEventSeq: r.start_event_seq, snapshotCommit: r.snapshot_commit, anchorCheckpointId: r.anchor_checkpoint_id }
  },

  rewindTranscript(sessionId: string, turn: number, startEventSeq: number): void {
    retrySqliteTransaction(db, () => { stmtTruncateEvents.run(sessionId, startEventSeq); stmtTruncateTurns.run(sessionId, turn) })
  },

  history(sessionId: string): AgentEvent[] {
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
    if (trimmed) stmtTitle.run(trimmed, sessionId)
  },

  /** Replace a session title unconditionally. */
  setTitle(sessionId: string, title: string): void {
    retrySqliteTransaction(db, () => stmtTitle.run(title, sessionId))
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
    return rows.map((r) => ({
      sessionId: r.id,
      title: r.title,
      createdAt: r.created_at,
      lastActivity: r.last_activity,
      workspace: r.workspace,
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
      $mode: goal.mode ?? "direct",
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

  // ---- Pinned model selection (optional; most sessions follow the global one) ----

  /** The session's pinned model selection, or null to follow the global active
   *  selection. Set at ship time so a goal-orchestrator session keeps its model
   *  even as the user's /model choice moves on. */
  pinnedSelectionOf(sessionId: string): PinnedSelection | null {
    const row = stmtSelection.get(sessionId) as { selection: string | null } | null
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
    stmtPinSelection.run(selection ? JSON.stringify(selection) : null, sessionId)
  },

  /** Atomically materialize a current-state child. Snapshot commits remain
   * reachable by their parent refs; copied turn metadata lets the child rewind. */
  forkSession(childId: string, parentId: string, workspace: string, kind: "normal" | "worktree", directive?: string, worktree?: { gitCommonDir: string; branch: string }): void {
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
