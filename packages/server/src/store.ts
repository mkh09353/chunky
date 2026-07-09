// Durable session + event store on bun:sqlite (native, no build step).
// Makes transcripts survive a server restart, so reconnecting to a sessionId
// replays the full prior run — i.e. "resume". Kept deliberately tiny.
import { Database } from "bun:sqlite"
import type { AgentEvent, SessionSummary } from "@mc/protocol"

const DB_PATH = process.env.MC_DB || "multicode.db"
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
`)

const stmtCreate = db.query(
  "INSERT INTO sessions (id, title, created_at, last_activity) VALUES (?, ?, ?, ?)",
)
const stmtTouch = db.query("UPDATE sessions SET last_activity = ? WHERE id = ?")
const stmtTitle = db.query("UPDATE sessions SET title = ? WHERE id = ?")
const stmtExists = db.query("SELECT 1 FROM sessions WHERE id = ?")
const stmtList = db.query(
  "SELECT id, title, created_at, last_activity FROM sessions ORDER BY last_activity DESC LIMIT 100",
)
const stmtNextSeq = db.query("SELECT COALESCE(MAX(seq), -1) + 1 AS n FROM events WHERE session_id = ?")
const stmtInsertEvent = db.query("INSERT INTO events (session_id, seq, json) VALUES (?, ?, ?)")
const stmtHistory = db.query("SELECT json FROM events WHERE session_id = ? ORDER BY seq ASC")

export const Store = {
  createSession(id: string, title = "New session"): void {
    const now = Date.now()
    stmtCreate.run(id, title, now, now)
  },

  exists(id: string): boolean {
    return stmtExists.get(id) != null
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

  list(): SessionSummary[] {
    const rows = stmtList.all() as {
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
}
