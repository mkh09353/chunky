import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CHECKPOINT_HISTORY_LIMIT, pruneCheckpointHistory } from "./bun-sqlite-saver.ts"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("checkpoint retention", () => {
  test("keeps a bounded resumable tail and removes writes for pruned checkpoints", () => {
    const dir = mkdtempSync(join(tmpdir(), "chunky-checkpoints-"))
    dirs.push(dir)
    const db = new Database(join(dir, "graph.db"))
    db.exec(`
      CREATE TABLE checkpoints (
        thread_id TEXT NOT NULL, checkpoint_ns TEXT NOT NULL DEFAULT '', checkpoint_id TEXT NOT NULL,
        parent_checkpoint_id TEXT, type TEXT, checkpoint BLOB, metadata BLOB,
        PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
      );
      CREATE TABLE writes (
        thread_id TEXT NOT NULL, checkpoint_ns TEXT NOT NULL DEFAULT '', checkpoint_id TEXT NOT NULL,
        task_id TEXT NOT NULL, idx INTEGER NOT NULL, channel TEXT NOT NULL, type TEXT, value BLOB,
        PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
      );
    `)

    const insertCheckpoint = db.prepare(
      "INSERT INTO checkpoints VALUES (?, '', ?, ?, 'json', '{}', '{}')",
    )
    const insertWrite = db.prepare(
      "INSERT INTO writes VALUES (?, '', ?, 'task', 0, 'messages', 'json', '{}')",
    )
    for (let i = 0; i < CHECKPOINT_HISTORY_LIMIT + 4; i++) {
      const id = String(i).padStart(4, "0")
      const parent = i === 0 ? null : String(i - 1).padStart(4, "0")
      insertCheckpoint.run("thread-a", id, parent)
      insertWrite.run("thread-a", id)
    }
    insertCheckpoint.run("thread-b", "0001", null)
    insertWrite.run("thread-b", "0001")

    pruneCheckpointHistory(db, "thread-a", "")

    expect((db.query("SELECT count(*) n FROM checkpoints WHERE thread_id='thread-a'").get() as any).n).toBe(
      CHECKPOINT_HISTORY_LIMIT,
    )
    expect((db.query("SELECT count(*) n FROM writes WHERE thread_id='thread-a'").get() as any).n).toBe(
      CHECKPOINT_HISTORY_LIMIT,
    )
    expect((db.query("SELECT count(*) n FROM checkpoints WHERE thread_id='thread-b'").get() as any).n).toBe(1)
    expect((db.query("SELECT min(checkpoint_id) id FROM checkpoints WHERE thread_id='thread-a'").get() as any).id).toBe(
      "0004",
    )
    db.close()
  })
})
