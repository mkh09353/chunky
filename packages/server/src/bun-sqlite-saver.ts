// A LangGraph checkpointer backed by bun:sqlite.
//
// Why this exists: the official @langchain/langgraph-checkpoint-sqlite SqliteSaver
// uses better-sqlite3, which Bun can't load (oven-sh/bun#4290), so it fell back to
// an in-memory saver and agent context memory was lost on restart. This is a
// faithful port of that SqliteSaver onto bun:sqlite — same schema, same SQL — so
// agent memory now survives a restart. Two Bun differences handled: prepared
// `.get()` returns null (not undefined) on no row, and undefined bind values are
// coerced to null (both drivers reject undefined).
import { Database } from "bun:sqlite"
import { openSqlite, retrySqliteBusy, retrySqliteTransaction } from "./sqlite.ts"
import {
  BaseCheckpointSaver,
  TASKS,
  copyCheckpoint,
  maxChannelVersion,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointMetadata,
  type CheckpointTuple,
  type PendingWrite,
  type SerializerProtocol,
} from "@langchain/langgraph-checkpoint"
import type { RunnableConfig } from "@langchain/core/runnables"

const checkpointMetadataKeys = ["source", "step", "parents"] as const

/** The latest checkpoint is sufficient to resume. A short tail preserves
 * interrupted-step recovery and useful debugging without retaining a complete,
 * repeatedly-copied conversation snapshot for every graph transition. */
export const CHECKPOINT_HISTORY_LIMIT = 5

export function pruneCheckpointHistory(
  db: Database,
  threadId: string,
  checkpointNs: string,
  limit = CHECKPOINT_HISTORY_LIMIT,
): void {
  const boundedLimit = Math.max(1, Math.floor(limit))
  const tx = () => {
    // Kept here too because this exported helper is exercised against bare
    // in-memory test databases, outside BunSqliteSaver.setup().
    db.exec(`CREATE TABLE IF NOT EXISTS checkpoint_anchors (
      thread_id TEXT NOT NULL, checkpoint_id TEXT NOT NULL, turn_index INTEGER NOT NULL,
      PRIMARY KEY (thread_id, checkpoint_id));`)
    db.prepare(
      `DELETE FROM checkpoints
       WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id NOT IN (
         SELECT checkpoint_id FROM checkpoints
         WHERE thread_id = ? AND checkpoint_ns = ?
         ORDER BY checkpoint_id DESC LIMIT ?
       ) AND checkpoint_id NOT IN (
         SELECT checkpoint_id FROM checkpoint_anchors WHERE thread_id = ?
       )`,
    ).run(threadId, checkpointNs, threadId, checkpointNs, boundedLimit, threadId)
    db.prepare(
      `DELETE FROM writes
       WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id NOT IN (
         SELECT checkpoint_id FROM checkpoints WHERE thread_id = ? AND checkpoint_ns = ?
       )`,
    ).run(threadId, checkpointNs, threadId, checkpointNs)
  }
  retrySqliteTransaction(db, tx)
}

// Checkpoint serialization is process-local. The promise is only held around
// synchronous SQLite work; serialization/serde work remains outside it.
let graphWriteQueue: Promise<void> = Promise.resolve()
function serializeGraphWrite<T>(work: () => T): Promise<T> {
  const previous = graphWriteQueue
  let release!: () => void
  graphWriteQueue = new Promise<void>((resolve) => { release = resolve })
  return previous.then(() => {
    try { return work() }
    finally { release() }
  })
}

function pruneAllCheckpointHistory(db: Database): void {
  const threads = db
    .prepare("SELECT DISTINCT thread_id, checkpoint_ns FROM checkpoints")
    .all() as Array<{ thread_id: string; checkpoint_ns: string }>
  for (const row of threads) pruneCheckpointHistory(db, row.thread_id, row.checkpoint_ns)
}

function nn<T>(v: T | undefined): T | null {
  return v === undefined ? null : v
}

function prepareSql(db: Database, withCheckpointId: boolean) {
  const sql = `
  SELECT thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata,
    (SELECT json_group_array(json_object('task_id', pw.task_id, 'channel', pw.channel, 'type', pw.type, 'value', CAST(pw.value AS TEXT)))
       FROM writes as pw
      WHERE pw.thread_id = checkpoints.thread_id AND pw.checkpoint_ns = checkpoints.checkpoint_ns AND pw.checkpoint_id = checkpoints.checkpoint_id) as pending_writes,
    (SELECT json_group_array(json_object('type', ps.type, 'value', CAST(ps.value AS TEXT)))
       FROM writes as ps
      WHERE ps.thread_id = checkpoints.thread_id AND ps.checkpoint_ns = checkpoints.checkpoint_ns AND ps.checkpoint_id = checkpoints.parent_checkpoint_id AND ps.channel = '${TASKS}'
      ORDER BY ps.idx) as pending_sends
  FROM checkpoints
  WHERE thread_id = ? AND checkpoint_ns = ? ${withCheckpointId ? "AND checkpoint_id = ?" : "ORDER BY checkpoint_id DESC LIMIT 1"}`
  return db.prepare(sql)
}

export class BunSqliteSaver extends BaseCheckpointSaver {
  private db: Database
  private isSetup = false
  private withoutCheckpoint!: ReturnType<Database["prepare"]>
  private withCheckpoint!: ReturnType<Database["prepare"]>

  constructor(db: Database, serde?: SerializerProtocol) {
    super(serde)
    this.db = db
  }

  static fromConnString(path: string): BunSqliteSaver {
    return new BunSqliteSaver(openSqlite(path))
  }

  private setup(): void {
    if (this.isSetup) return
    this.db.exec(`CREATE TABLE IF NOT EXISTS checkpoints (
      thread_id TEXT NOT NULL, checkpoint_ns TEXT NOT NULL DEFAULT '', checkpoint_id TEXT NOT NULL,
      parent_checkpoint_id TEXT, type TEXT, checkpoint BLOB, metadata BLOB,
      PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id));`)
    this.db.exec(`CREATE TABLE IF NOT EXISTS writes (
      thread_id TEXT NOT NULL, checkpoint_ns TEXT NOT NULL DEFAULT '', checkpoint_id TEXT NOT NULL,
      task_id TEXT NOT NULL, idx INTEGER NOT NULL, channel TEXT NOT NULL, type TEXT, value BLOB,
      PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx));`)
    this.db.exec(`CREATE TABLE IF NOT EXISTS checkpoint_anchors (
      thread_id TEXT NOT NULL, checkpoint_id TEXT NOT NULL, turn_index INTEGER NOT NULL,
      PRIMARY KEY (thread_id, checkpoint_id));`)
    retrySqliteBusy(() => pruneAllCheckpointHistory(this.db))
    this.withoutCheckpoint = prepareSql(this.db, false)
    this.withCheckpoint = prepareSql(this.db, true)
    this.isSetup = true
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    this.setup()
    const { thread_id, checkpoint_ns = "", checkpoint_id } = config.configurable ?? {}
    const args = checkpoint_id ? [thread_id, checkpoint_ns, checkpoint_id] : [thread_id, checkpoint_ns]
    const row = (checkpoint_id ? this.withCheckpoint : this.withoutCheckpoint).get(...args) as any
    if (row == null) return undefined

    let finalConfig = config
    if (!checkpoint_id) {
      finalConfig = { configurable: { thread_id: row.thread_id, checkpoint_ns, checkpoint_id: row.checkpoint_id } }
    }
    if (finalConfig.configurable?.thread_id == null || finalConfig.configurable?.checkpoint_id == null) {
      throw new Error("Missing thread_id or checkpoint_id")
    }
    const pendingWrites = await Promise.all(
      (JSON.parse(row.pending_writes) as any[]).map(async (w) => [
        w.task_id,
        w.channel,
        await this.serde.loadsTyped(w.type ?? "json", w.value ?? ""),
      ]),
    )
    const checkpoint = (await this.serde.loadsTyped(row.type ?? "json", row.checkpoint)) as Checkpoint
    if ((checkpoint as any).v < 4 && row.parent_checkpoint_id != null) {
      await this.migratePendingSends(checkpoint, row.thread_id, row.parent_checkpoint_id)
    }
    return {
      checkpoint,
      config: finalConfig,
      metadata: (await this.serde.loadsTyped(row.type ?? "json", row.metadata)) as CheckpointMetadata,
      parentConfig: row.parent_checkpoint_id
        ? { configurable: { thread_id: row.thread_id, checkpoint_ns, checkpoint_id: row.parent_checkpoint_id } }
        : undefined,
      pendingWrites: pendingWrites as CheckpointTuple["pendingWrites"],
    }
  }

  async *list(config: RunnableConfig, options?: CheckpointListOptions): AsyncGenerator<CheckpointTuple> {
    const { limit, before, filter } = options ?? {}
    this.setup()
    const thread_id = config.configurable?.thread_id
    const checkpoint_ns = config.configurable?.checkpoint_ns
    let sql = `
      SELECT thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata,
        (SELECT json_group_array(json_object('task_id', pw.task_id, 'channel', pw.channel, 'type', pw.type, 'value', CAST(pw.value AS TEXT)))
           FROM writes as pw
          WHERE pw.thread_id = checkpoints.thread_id AND pw.checkpoint_ns = checkpoints.checkpoint_ns AND pw.checkpoint_id = checkpoints.checkpoint_id) as pending_writes,
        (SELECT json_group_array(json_object('type', ps.type, 'value', CAST(ps.value AS TEXT)))
           FROM writes as ps
          WHERE ps.thread_id = checkpoints.thread_id AND ps.checkpoint_ns = checkpoints.checkpoint_ns AND ps.checkpoint_id = checkpoints.parent_checkpoint_id AND ps.channel = '${TASKS}'
          ORDER BY ps.idx) as pending_sends
      FROM checkpoints\n`
    const where: string[] = []
    if (thread_id) where.push("thread_id = ?")
    if (checkpoint_ns !== undefined && checkpoint_ns !== null) where.push("checkpoint_ns = ?")
    if (before?.configurable?.checkpoint_id !== undefined) where.push("checkpoint_id < ?")
    const sanitizedFilter = Object.fromEntries(
      Object.entries(filter ?? {}).filter(
        ([k, v]) => v !== undefined && (checkpointMetadataKeys as readonly string[]).includes(k),
      ),
    )
    where.push(...Object.keys(sanitizedFilter).map((k) => `jsonb(CAST(metadata AS TEXT))->'$.${k}' = ?`))
    if (where.length) sql += `WHERE\n  ${where.join(" AND\n  ")}\n`
    sql += "\nORDER BY checkpoint_id DESC"
    if (limit) sql += ` LIMIT ${parseInt(String(limit), 10)}`

    const args = [
      thread_id,
      checkpoint_ns,
      before?.configurable?.checkpoint_id,
      ...Object.values(sanitizedFilter).map((v) => JSON.stringify(v)),
    ].filter((v) => v !== undefined && v !== null)

    const rows = this.db.prepare(sql).all(...args) as any[]
    for (const row of rows ?? []) {
      const pendingWrites = await Promise.all(
        (JSON.parse(row.pending_writes) as any[]).map(async (w) => [
          w.task_id,
          w.channel,
          await this.serde.loadsTyped(w.type ?? "json", w.value ?? ""),
        ]),
      )
      const checkpoint = (await this.serde.loadsTyped(row.type ?? "json", row.checkpoint)) as Checkpoint
      if ((checkpoint as any).v < 4 && row.parent_checkpoint_id != null) {
        await this.migratePendingSends(checkpoint, row.thread_id, row.parent_checkpoint_id)
      }
      yield {
        config: { configurable: { thread_id: row.thread_id, checkpoint_ns: row.checkpoint_ns, checkpoint_id: row.checkpoint_id } },
        checkpoint,
        metadata: (await this.serde.loadsTyped(row.type ?? "json", row.metadata)) as CheckpointMetadata,
        parentConfig: row.parent_checkpoint_id
          ? { configurable: { thread_id: row.thread_id, checkpoint_ns: row.checkpoint_ns, checkpoint_id: row.parent_checkpoint_id } }
          : undefined,
        pendingWrites: pendingWrites as CheckpointTuple["pendingWrites"],
      }
    }
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
  ): Promise<RunnableConfig> {
    this.setup()
    if (!config.configurable) throw new Error("Empty configuration supplied.")
    const thread_id = config.configurable?.thread_id
    const checkpoint_ns = config.configurable?.checkpoint_ns ?? ""
    const parent_checkpoint_id = config.configurable?.checkpoint_id
    if (!thread_id) throw new Error(`Missing "thread_id" field in passed "config.configurable".`)

    const preparedCheckpoint = copyCheckpoint(checkpoint)
    const [[type1, sCheckpoint], [type2, sMetadata]] = await Promise.all([
      this.serde.dumpsTyped(preparedCheckpoint),
      this.serde.dumpsTyped(metadata),
    ])
    if (type1 !== type2) throw new Error("Failed to serialize checkpoint and metadata to the same type.")

    await serializeGraphWrite(() => retrySqliteBusy(() => {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO checkpoints (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(thread_id, checkpoint_ns, checkpoint.id, nn(parent_checkpoint_id), type1, sCheckpoint, sMetadata)
      pruneCheckpointHistory(this.db, thread_id, checkpoint_ns)
    }))

    return { configurable: { thread_id, checkpoint_ns, checkpoint_id: checkpoint.id } }
  }

  async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void> {
    this.setup()
    if (!config.configurable) throw new Error("Empty configuration supplied.")
    if (!config.configurable?.thread_id) throw new Error("Missing thread_id field in config.configurable.")
    if (!config.configurable?.checkpoint_id) throw new Error("Missing checkpoint_id field in config.configurable.")

    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO writes (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, type, value) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    const rows = await Promise.all(
      writes.map(async (write, idx) => {
        const [type, sWrite] = await this.serde.dumpsTyped(write[1])
        return [
          config.configurable?.thread_id,
          config.configurable?.checkpoint_ns ?? "",
          config.configurable?.checkpoint_id,
          taskId,
          idx,
          write[0],
          type,
          sWrite,
        ]
      }),
    )
    await serializeGraphWrite(() => retrySqliteBusy(() => {
      const tx = (batch: any[][]) => {
        for (const row of batch) stmt.run(...row.map(nn))
      }
      retrySqliteTransaction(this.db, () => tx(rows))
    }))
  }

  async deleteThread(threadId: string): Promise<void> {
    const tx = () => {
      this.db.prepare(`DELETE FROM checkpoints WHERE thread_id = ?`).run(threadId)
      this.db.prepare(`DELETE FROM writes WHERE thread_id = ?`).run(threadId)
    }
    await serializeGraphWrite(() => retrySqliteTransaction(this.db, tx))
  }

  private async migratePendingSends(checkpoint: Checkpoint, threadId: string, parentCheckpointId: string): Promise<void> {
    const row = this.db
      .prepare(
        `SELECT json_group_array(json_object('type', ps.type, 'value', CAST(ps.value AS TEXT))) as pending_sends
           FROM writes as ps
          WHERE ps.thread_id = ? AND ps.checkpoint_id = ? AND ps.channel = '${TASKS}'
          ORDER BY ps.idx`,
      )
      .get(threadId, parentCheckpointId) as any
    const mutable = checkpoint as any
    mutable.channel_values ??= {}
    mutable.channel_values[TASKS] = await Promise.all(
      (JSON.parse(row.pending_sends) as any[]).map(({ type, value }) => this.serde.loadsTyped(type, value)),
    )
    mutable.channel_versions[TASKS] =
      Object.keys(checkpoint.channel_versions).length > 0
        ? maxChannelVersion(...(Object.values(checkpoint.channel_versions) as any[]))
        : this.getNextVersion(undefined)
  }
}

/** Routes checkpoint threads to the process-local saver for incognito roots. */
const incognitoThreads = new Set<string>()
export function registerIncognitoThread(threadId: string): void { incognitoThreads.add(threadId) }
export function isRegisteredIncognitoThread(threadId: string): boolean { return incognitoThreads.has(threadId) }

export class IncognitoCheckpointSaver extends BaseCheckpointSaver {
  private readonly durable: BunSqliteSaver
  private readonly memory: BunSqliteSaver
  constructor(durable: BunSqliteSaver, memory = BunSqliteSaver.fromConnString(":memory:"), serde?: SerializerProtocol) {
    super(serde); this.durable = durable; this.memory = memory
  }
  private saver(config: RunnableConfig): BunSqliteSaver {
    const id = String(config.configurable?.thread_id ?? "")
    return incognitoThreads.has(id) || [...incognitoThreads].some((root) => id === root || id.startsWith(`${root}:`)) ? this.memory : this.durable
  }
  getTuple(c: RunnableConfig) { return this.saver(c).getTuple(c) }
  list(c: RunnableConfig, o?: CheckpointListOptions) { return this.saver(c).list(c, o) }
  put(c: RunnableConfig, cp: Checkpoint, m: CheckpointMetadata, _versions: unknown) { return this.saver(c).put(c, cp, m) }
  putWrites(c: RunnableConfig, w: PendingWrite[], t: string) { return this.saver(c).putWrites(c, w, t) }
  deleteThread(id: string) { return this.saver({ configurable: { thread_id: id } }).deleteThread(id) }
}

/** The rewind API uses the same graph DB, even when no saver instance happens
 * to be active in this request. */
function graphDb(): Database {
  const db = openSqlite(process.env.CHUNKY_GRAPH_DB || "chunky-graph.db")
  db.exec(`CREATE TABLE IF NOT EXISTS checkpoint_anchors (
    thread_id TEXT NOT NULL, checkpoint_id TEXT NOT NULL, turn_index INTEGER NOT NULL,
    PRIMARY KEY (thread_id, checkpoint_id));`)
  return db
}

export function anchorLatestCheckpoint(threadId: string, turnIndex: number): string | null {
  const db = graphDb()
  const row = db.prepare("SELECT checkpoint_id FROM checkpoints WHERE thread_id = ? ORDER BY checkpoint_id DESC LIMIT 1").get(threadId) as { checkpoint_id: string } | null
  if (!row) return null
  retrySqliteTransaction(db, () => {
    db.prepare("INSERT OR REPLACE INTO checkpoint_anchors (thread_id, checkpoint_id, turn_index) VALUES (?, ?, ?)").run(threadId, row.checkpoint_id, turnIndex)
    db.prepare(`DELETE FROM checkpoint_anchors WHERE thread_id = ? AND checkpoint_id IN (
      SELECT checkpoint_id FROM checkpoint_anchors WHERE thread_id = ? ORDER BY turn_index DESC LIMIT -1 OFFSET 50
    )`).run(threadId, threadId)
  })
  return row.checkpoint_id
}

export function rewindCheckpoints(threadId: string, checkpointId: string): void {
  const db = graphDb()
  retrySqliteTransaction(db, () => {
    db.prepare("DELETE FROM writes WHERE thread_id = ? AND checkpoint_id > ?").run(threadId, checkpointId)
    db.prepare("DELETE FROM checkpoints WHERE thread_id = ? AND checkpoint_id > ?").run(threadId, checkpointId)
    db.prepare("DELETE FROM checkpoint_anchors WHERE thread_id = ? AND checkpoint_id > ?").run(threadId, checkpointId)
  })
}

/** Forks may have no completed anchor; that is intentionally a fresh agent
 * state rather than a failed fork. The copied checkpoint is a new root. */
export function cloneThreadAtCheckpoint(sourceThreadId: string, targetThreadId: string, checkpointId: string): boolean {
  const db = graphDb()
  const checkpoint = db.prepare("SELECT * FROM checkpoints WHERE thread_id = ? AND checkpoint_id = ?").get(sourceThreadId, checkpointId) as any
  if (!checkpoint) return false
  retrySqliteTransaction(db, () => {
    db.prepare("INSERT OR REPLACE INTO checkpoints (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata) VALUES (?, ?, ?, NULL, ?, ?, ?)")
      .run(targetThreadId, checkpoint.checkpoint_ns, checkpoint.checkpoint_id, checkpoint.type, checkpoint.checkpoint, checkpoint.metadata)
    const writes = db.prepare("SELECT * FROM writes WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?").all(sourceThreadId, checkpoint.checkpoint_ns, checkpointId) as any[]
    const insert = db.prepare("INSERT OR REPLACE INTO writes (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, type, value) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    for (const w of writes) insert.run(targetThreadId, w.checkpoint_ns, w.checkpoint_id, w.task_id, w.idx, w.channel, w.type, w.value)
  })
  return true
}
