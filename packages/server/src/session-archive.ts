import { createReadStream, createWriteStream, existsSync, mkdirSync, openSync, closeSync, fsyncSync, renameSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"
import { createGzip, createGunzip } from "node:zlib"
import { createInterface } from "node:readline"
import { once } from "node:events"
import { createHash, randomUUID } from "node:crypto"
import { Database } from "bun:sqlite"
import { openSqlite, retrySqliteTransaction } from "./sqlite.ts"
import { durableDbPath } from "./store.ts"
import { stateDir } from "./repos.ts"
import { BunSqliteSaver } from "./bun-sqlite-saver.ts"

export const ARCHIVE_AFTER_DAYS = 14
const PAGE_SIZE = 1_000
const graphPath = () => process.env.CHUNKY_GRAPH_DB || "chunky-graph.db"
const archivePath = (id: string) => join(stateDir(), "archive", `${id}.jsonl.gz`)
const VACUUM_FREELIST_BYTES = 50 * 1024 * 1024

export function vacuumIfBloated(db: Database): boolean {
  const pageSize = (db.query("PRAGMA page_size").get() as { page_size: number }).page_size
  const freePages = (db.query("PRAGMA freelist_count").get() as { freelist_count: number }).freelist_count
  if (pageSize * freePages <= VACUUM_FREELIST_BYTES) return false
  db.exec("VACUUM")
  return true
}

function write(stream: NodeJS.WritableStream, line: string): Promise<void> | void {
  if (!stream.write(line)) return once(stream, "drain").then(() => undefined)
}

export async function archiveSession(sessionId: string): Promise<boolean> {
  const db = openSqlite(durableDbPath)
  const session = db.query("SELECT id,title,workspace,created_at,last_activity,incognito,history_generation FROM sessions WHERE id=?").get(sessionId) as any
  if (!session || session.incognito) return false
  const goal = db.query("SELECT * FROM goals WHERE session_id=?").get(sessionId) as any
  if (goal?.status === "active") return false
  const turns = db.query("SELECT * FROM session_turns WHERE session_id=? ORDER BY turn_index").all(sessionId)
  const threads = new Set<string>([sessionId])
  for (const row of db.query("SELECT json FROM events WHERE session_id=? AND json_extract(json,'$.type')='thread.spawn'").all(sessionId) as Array<{ json: string }>) {
    try { const id = JSON.parse(row.json).threadId; if (typeof id === "string") threads.add(id) } catch {}
  }
  const target = archivePath(sessionId), temp = `${target}.tmp-${process.pid}`
  mkdirSync(dirname(target), { recursive: true })
  const gzip = createGzip(), output = createWriteStream(temp, { mode: 0o600 })
  gzip.pipe(output)
  await write(gzip, JSON.stringify({ version: 1, sessionId, title: session.title, workspace: session.workspace, createdAt: session.created_at, lastActivity: session.last_activity, historyGeneration: session.history_generation || randomUUID(), turns, goal: goal ?? null }) + "\n")
  let after = -1
  for (;;) {
    const rows = db.query("SELECT seq,json FROM events WHERE session_id=? AND seq>? ORDER BY seq LIMIT ?").all(sessionId, after, PAGE_SIZE) as Array<{ seq: number; json: string }>
    if (!rows.length) break
    for (const row of rows) await write(gzip, JSON.stringify(row) + "\n")
    after = rows.at(-1)!.seq
  }
  gzip.end(); await once(output, "close")
  const fd = openSync(temp, "r"); fsyncSync(fd); closeSync(fd)
  const digest = createHash("sha256")
  let byteLength = 0
  for await (const chunk of createReadStream(temp)) { const bytes = chunk as Buffer; byteLength += bytes.byteLength; digest.update(bytes) }
  const sha256 = digest.digest("hex")
  renameSync(temp, target)
  retrySqliteTransaction(db, () => {
    db.query("INSERT OR REPLACE INTO archived_sessions (id,title,workspace,created_at,last_activity,archived_at,byte_length,sha256) VALUES (?,?,?,?,?,?,?,?)").run(sessionId, session.title, session.workspace, session.created_at, session.last_activity, Date.now(), byteLength, sha256)
    for (const table of ["events", "session_turns", "goals", "todos", "session_compaction_artifacts"]) db.query(`DELETE FROM ${table} WHERE session_id=?`).run(sessionId)
    db.query("DELETE FROM sessions WHERE id=?").run(sessionId)
  })
  vacuumIfBloated(db)
  const attachments = join(stateDir(), "attachments", sessionId), archivedAttachments = join(stateDir(), "archive", "attachments", sessionId)
  if (existsSync(attachments)) { mkdirSync(dirname(archivedAttachments), { recursive: true }); rmSync(archivedAttachments, { recursive: true, force: true }); renameSync(attachments, archivedAttachments) }
  const saver = BunSqliteSaver.fromConnString(graphPath())
  for (const thread of threads) await saver.deleteThread(thread)
  return true
}

const rehydrating = new Map<string, Promise<boolean>>()

async function restoreSession(sessionId: string): Promise<boolean> {
  const db = openSqlite(durableDbPath), target = archivePath(sessionId)
  const pointer = db.query("SELECT byte_length,sha256 FROM archived_sessions WHERE id=?").get(sessionId) as { byte_length: number | null; sha256: string | null } | null
  if (!existsSync(target)) {
    if (pointer) throw new Error(`archive file missing for session ${sessionId}`)
    return db.query("SELECT 1 FROM sessions WHERE id=?").get(sessionId) != null
  }
  if (!pointer?.byte_length || !pointer.sha256) throw new Error(`archive integrity metadata missing for session ${sessionId}`)
  const digest = createHash("sha256")
  let byteLength = 0
  for await (const chunk of createReadStream(target)) { const bytes = chunk as Buffer; byteLength += bytes.byteLength; digest.update(bytes) }
  const sha256 = digest.digest("hex")
  if (byteLength !== pointer.byte_length || sha256 !== pointer.sha256) throw new Error(`archive integrity check failed for session ${sessionId}`)
  const lines = createInterface({ input: createReadStream(target).pipe(createGunzip()), crlfDelay: Infinity })
  let header: any, page: Array<{ seq: number; json: string }> = []
  const insertPage = () => retrySqliteTransaction(db, () => { for (const row of page) db.query("INSERT OR IGNORE INTO events VALUES (?,?,?)").run(sessionId, row.seq, row.json); page = [] })
  for await (const line of lines) {
    if (!header) {
      header = JSON.parse(line)
      db.query("INSERT OR IGNORE INTO sessions (id,title,created_at,last_activity,workspace,incognito,history_generation) VALUES (?,?,?,?,?,0,?)").run(sessionId, header.title, header.createdAt, header.lastActivity, header.workspace, typeof header.historyGeneration === "string" && header.historyGeneration ? header.historyGeneration : randomUUID())
      for (const t of header.turns ?? []) db.query("INSERT OR IGNORE INTO session_turns VALUES (?,?,?,?,?,?,?,?,?,?)").run(t.session_id,t.turn_index,t.start_event_seq,t.end_event_seq,t.snapshot_commit,t.anchor_checkpoint_id,t.user_text,t.status,t.created_at,t.completed_at)
      const g = header.goal
      if (g) db.query("INSERT OR IGNORE INTO goals (session_id,objective,status,mode,created_at,updated_at,turns,max_turns,evidence,blocked_reason) VALUES (?,?,?,?,?,?,?,?,?,?)").run(g.session_id,g.objective,g.status,g.mode,g.created_at,g.updated_at,g.turns,g.max_turns,g.evidence,g.blocked_reason)
      continue
    }
    page.push(JSON.parse(line)); if (page.length >= PAGE_SIZE) insertPage()
  }
  if (page.length) insertPage()
  const attachments = join(stateDir(), "archive", "attachments", sessionId), restored = join(stateDir(), "attachments", sessionId)
  if (existsSync(attachments) && !existsSync(restored)) { mkdirSync(dirname(restored), { recursive: true }); renameSync(attachments, restored) }
  db.query("DELETE FROM archived_sessions WHERE id=?").run(sessionId)
  rmSync(target, { force: true })
  return true
}

/** Single-flight lazy restore shared by HTTP and inter-session delivery. */
export function rehydrateSession(sessionId: string): Promise<boolean> {
  const existing = rehydrating.get(sessionId)
  if (existing) return existing
  const restore = restoreSession(sessionId).finally(() => rehydrating.delete(sessionId))
  rehydrating.set(sessionId, restore)
  return restore
}

export async function sweepArchives(now = Date.now(), running = new Set<string>()): Promise<string[]> {
  const db = openSqlite(durableDbPath), cutoff = now - ARCHIVE_AFTER_DAYS * 86_400_000
  try { db.query("DELETE FROM resource_samples WHERE ts < ?").run(cutoff) } catch {}
  const rows = db.query("SELECT id FROM sessions WHERE last_activity<? AND incognito=0 AND id NOT IN (SELECT session_id FROM goals WHERE status='active')").all(cutoff) as Array<{ id: string }>
  const archived: string[] = []
  for (const row of rows) if (!running.has(row.id) && await archiveSession(row.id)) archived.push(row.id)
  retrySqliteTransaction(db, () => {
    const protectedIds = [...running]
    const runningClause = protectedIds.length ? ` AND session_id NOT IN (${protectedIds.map(() => "?").join(",")})` : ""
    for (const table of ["events", "session_turns"]) {
      db.query(`DELETE FROM ${table} WHERE NOT EXISTS (SELECT 1 FROM sessions WHERE sessions.id=${table}.session_id)${runningClause}`).run(...protectedIds)
    }
  })
  await sweepOrphanCheckpoints(running)
  vacuumIfBloated(openSqlite(graphPath()))
  return archived
}

export async function sweepOrphanCheckpoints(running = new Set<string>()): Promise<number> {
  const graph = openSqlite(graphPath()), store = openSqlite(durableDbPath)
  const saver = BunSqliteSaver.fromConnString(graphPath())
  // Set up all three graph tables before inspecting them. deleteThread uses the
  // same saver so checkpoints, pending writes, and turn anchors remain aligned.
  await saver.deleteThread("__archive_sweep_setup__")
  const ids = graph.query("SELECT thread_id id FROM checkpoints UNION SELECT thread_id FROM writes UNION SELECT thread_id FROM checkpoint_anchors").all() as Array<{ id: string }>
  const roots = new Set(running)
  for (const row of store.query("SELECT id FROM sessions UNION SELECT id FROM archived_sessions UNION SELECT session_id id FROM goals WHERE status='active'").all() as Array<{ id: string }>) roots.add(row.id)
  const liveChildThreads = new Set<string>()
  for (const row of store.query("SELECT events.json FROM events JOIN sessions ON sessions.id=events.session_id WHERE json_extract(events.json,'$.type')='thread.spawn'").all() as Array<{ json: string }>) {
    try {
      const id = JSON.parse(row.json).threadId
      if (typeof id === "string" && id.startsWith("child-")) liveChildThreads.add(id)
    } catch {}
  }
  let deleted = 0
  for (const row of ids) {
    const root = row.id.split(":", 1)[0]!
    if (roots.has(root) || row.id.startsWith("child-") && liveChildThreads.has(row.id)) continue
    await saver.deleteThread(row.id)
    deleted++
  }
  return deleted
}
