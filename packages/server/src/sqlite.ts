import { Database } from "bun:sqlite"

export const SQLITE_BUSY_TIMEOUT_MS = 5_000
export const SQLITE_BUSY_ATTEMPTS = 4

// bun:sqlite connections are process-local resources. Sharing them avoids
// making separate writers contend with one another inside this process (the
// busy retry logic still protects against other processes).
const openConnections = new Map<string, Database>()

export function openSqlite(path: string): Database {
  const existing = openConnections.get(path)
  if (existing) return existing

  const db = new Database(path)
  db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS};`)
  db.exec("PRAGMA synchronous = NORMAL;")
  db.exec("PRAGMA journal_mode = WAL;")
  openConnections.set(path, db)
  return db
}

export function isSqliteBusy(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /database is locked|database table is locked|SQLITE_BUSY|SQLITE_LOCKED/i.test(message)
}

/** Retry a complete synchronous DB operation, never a statement in isolation. */
export function retrySqliteBusy<T>(operation: () => T, attempts = SQLITE_BUSY_ATTEMPTS): T {
  for (let attempt = 0; ; attempt++) {
    try {
      return operation()
    } catch (error) {
      if (!isSqliteBusy(error) || attempt + 1 >= attempts) throw error
      // The operation is synchronous; this deliberately remains a bounded,
      // small backoff rather than holding a transaction open while awaiting.
      const delay = 10 * (attempt + 1)
      const until = Date.now() + delay
      while (Date.now() < until) {}
    }
  }
}

export function databaseErrorMessage(error: unknown): string {
  return isSqliteBusy(error) ? "database contention — retry" : error instanceof Error ? error.message : String(error)
}

export function retrySqliteTransaction<T>(db: Database, work: () => T): T {
  return retrySqliteBusy(() => {
    db.exec("BEGIN IMMEDIATE")
    try {
      const result = work()
      db.exec("COMMIT")
      return result
    } catch (error) {
      try { db.exec("ROLLBACK") } catch {}
      throw error
    }
  })
}
