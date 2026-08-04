import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunSqliteSaver, CHECKPOINT_HISTORY_LIMIT, cloneThreadAtCheckpoint, pruneCheckpointHistory } from "./bun-sqlite-saver.ts"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("checkpoint retention", () => {
  test("serializes separate checkpoint puts inside the write queue", async () => {
    let activeSerializers = 0
    let maxActiveSerializers = 0
    const serde = {
      async dumpsTyped(value: unknown) {
        activeSerializers++
        maxActiveSerializers = Math.max(maxActiveSerializers, activeSerializers)
        await Bun.sleep(10)
        activeSerializers--
        return ["json", JSON.stringify(value)] as [string, string]
      },
      async loadsTyped(_type: string, value: string) { return JSON.parse(value) },
    }
    const saver = new BunSqliteSaver(new Database(":memory:"), serde as any)

    await Promise.all(Array.from({ length: 4 }, (_, i) => saver.put(
      { configurable: { thread_id: `thread-${i}` } },
      { v: 4, id: `checkpoint-${i}`, ts: "", channel_values: {}, channel_versions: {}, versions_seen: {} } as any,
      {} as any,
    )))

    // One put serializes its checkpoint and metadata together; separate puts wait.
    expect(maxActiveSerializers).toBe(2)
  })

  test("serializes pending-write batches and recovers after a queued failure", async () => {
    let activeSerializers = 0
    let maxActiveSerializers = 0
    let rejectNext = true
    const serde = {
      async dumpsTyped(value: unknown) {
        if (rejectNext) { rejectNext = false; throw new Error("serialization failed") }
        activeSerializers++
        maxActiveSerializers = Math.max(maxActiveSerializers, activeSerializers)
        await Bun.sleep(10)
        activeSerializers--
        return ["json", JSON.stringify(value)] as [string, string]
      },
      async loadsTyped(_type: string, value: string) { return JSON.parse(value) },
    }
    const db = new Database(":memory:")
    const saver = new BunSqliteSaver(db, serde as any)
    const config = { configurable: { thread_id: "thread", checkpoint_id: "checkpoint" } }

    await expect(saver.putWrites(config, [["messages", { failed: true }]] as any, "failed-task")).rejects.toThrow("serialization failed")
    await Promise.all([
      saver.putWrites(config, [["messages", { batch: 1 }]] as any, "task-1"),
      saver.putWrites(config, [["messages", { batch: 2 }]] as any, "task-2"),
    ])

    expect(maxActiveSerializers).toBe(1)
    expect((db.query("SELECT count(*) AS n FROM writes").get() as { n: number }).n).toBe(2)
  })

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

  test("does not trim checkpoints that remain ancestors of a retained branch tip", () => {
    const db = new Database(":memory:")
    db.exec(`
      CREATE TABLE checkpoints (thread_id TEXT, checkpoint_ns TEXT DEFAULT '', checkpoint_id TEXT, parent_checkpoint_id TEXT, type TEXT, checkpoint BLOB, metadata BLOB, PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id));
      CREATE TABLE writes (thread_id TEXT, checkpoint_ns TEXT DEFAULT '', checkpoint_id TEXT, task_id TEXT, idx INTEGER, channel TEXT, type TEXT, value BLOB, PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx));
    `)
    const checkpoint = db.prepare("INSERT INTO checkpoints VALUES ('t', '', ?, ?, 'json', '{}', '{}')")
    const write = db.prepare("INSERT INTO writes VALUES ('t', '', ?, 'task', 0, 'messages', 'json', '{}')")
    checkpoint.run("root", null); write.run("root")
    for (let i = 1; i <= CHECKPOINT_HISTORY_LIMIT + 2; i++) {
      const id = `main-${i}`
      checkpoint.run(id, i === 1 ? "root" : `main-${i - 1}`); write.run(id)
    }
    checkpoint.run("branch", "root"); write.run("branch")
    pruneCheckpointHistory(db, "t", "")
    expect((db.query("SELECT count(*) n FROM checkpoints WHERE checkpoint_id='root'").get() as any).n).toBe(1)
    expect((db.query("SELECT count(*) n FROM writes WHERE checkpoint_id='root'").get() as any).n).toBe(1)
    db.close()
  })

  test("clones exactly one checkpoint and its writes as a parentless child root", () => {
    const dir = mkdtempSync(join(tmpdir(), "chunky-graph-")); dirs.push(dir)
    const old = process.env.CHUNKY_GRAPH_DB; process.env.CHUNKY_GRAPH_DB = join(dir, "graph.db")
    try {
      const db = new Database(process.env.CHUNKY_GRAPH_DB)
      db.exec("CREATE TABLE checkpoints (thread_id TEXT, checkpoint_ns TEXT, checkpoint_id TEXT, parent_checkpoint_id TEXT, type TEXT, checkpoint BLOB, metadata BLOB); CREATE TABLE writes (thread_id TEXT, checkpoint_ns TEXT, checkpoint_id TEXT, task_id TEXT, idx INTEGER, channel TEXT, type TEXT, value BLOB)")
      db.prepare("INSERT INTO checkpoints VALUES ('parent', '', 'a', 'older', 'json', 'state', 'meta')").run()
      db.prepare("INSERT INTO checkpoints VALUES ('parent', '', 'b', 'a', 'json', 'later', 'meta')").run()
      db.prepare("INSERT INTO writes VALUES ('parent', '', 'a', 'task', 0, 'x', 'json', 'value')").run()
      expect(cloneThreadAtCheckpoint("parent", "child", "a")).toBe(true)
      expect(db.query("SELECT checkpoint_id, parent_checkpoint_id, checkpoint FROM checkpoints WHERE thread_id='child'").get()).toEqual({ checkpoint_id: "a", parent_checkpoint_id: null, checkpoint: "state" })
      expect(db.query("SELECT checkpoint_id, value FROM writes WHERE thread_id='child'").get()).toEqual({ checkpoint_id: "a", value: "value" })
      expect((db.query("SELECT count(*) n FROM checkpoints WHERE thread_id='parent'").get() as any).n).toBe(2)
      db.close()
    } finally { if (old === undefined) delete process.env.CHUNKY_GRAPH_DB; else process.env.CHUNKY_GRAPH_DB = old }
  })
})
