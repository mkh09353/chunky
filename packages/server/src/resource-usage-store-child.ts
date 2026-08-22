import { expect } from "bun:test"
import { Database } from "bun:sqlite"

const dbPath = process.env.CHUNKY_DB!
const mode = process.env.RESOURCE_STORE_MODE

if (mode === "migration") {
  const old = new Database(dbPath)
  old.exec(`CREATE TABLE resource_samples (
    id INTEGER PRIMARY KEY,
    ts INTEGER NOT NULL,
    scope TEXT NOT NULL,
    rss_bytes INTEGER NOT NULL
  )`)
  old.query("INSERT INTO resource_samples (ts,scope,rss_bytes) VALUES (?,?,?)").run(1, "server", 100)
  old.close()

  const { Store } = await import("./store.ts")
  const migrated = new Database(dbPath)
  const columns = (migrated.query("PRAGMA table_info(resource_samples)").all() as Array<{ name: string }>).map((c) => c.name)
  for (const column of ["session_id", "task_id", "pid", "heap_used_bytes", "cpu_percent", "active_sessions", "live_tasks", "live_delegates", "command"]) {
    expect(columns).toContain(column)
  }
  expect(migrated.query("SELECT session_id,task_id,heap_used_bytes,cpu_percent,command FROM resource_samples WHERE ts=1").get())
    .toEqual({ session_id: null, task_id: null, heap_used_bytes: null, cpu_percent: null, command: null })
  Store.logResourceSamples([{ ts: 2, scope: "server", rssBytes: 200, heapUsedBytes: 50, cpuPercent: 1.5 }])
  expect(Store.resourceUsage(0, 10)).toHaveLength(2)
  Store.logResourceSamples([{ ts: 2, scope: "server", rssBytes: 200, heapUsedBytes: 50, cpuPercent: 1.5 }])
  expect(Store.resourceUsage(0, 10)).toHaveLength(3)
  migrated.close()
  console.log("resource store migration: ok")
} else {
  const { Store } = await import("./store.ts")
  Store.logResourceSamples([
    { ts: 1_000, scope: "server", rssBytes: 100, heapUsedBytes: 10, cpuPercent: 1, activeSessions: 2, liveTasks: 1, liveDelegates: 0 },
    { ts: 1_000, scope: "task", sessionId: "s", taskId: "t1", pid: 9, rssBytes: 20, cpuPercent: 4, command: "npm run dev" },
  ])
  const rows = Store.resourceUsage(1_000, 1_001)
  expect(rows).toHaveLength(2)
  expect(rows[0]).toMatchObject({ scope: "server", rssBytes: 100, heapUsedBytes: 10, activeSessions: 2 })
  expect(rows[1]).toMatchObject({ scope: "task", taskId: "t1", command: "npm run dev", rssBytes: 20 })
  expect(Store.resourceUsage(2_000, 3_000)).toEqual([])
  Store.logResourceSamples([{ ts: 1, scope: "server", rssBytes: 1 }])
  expect(Store.pruneResourceSamples(14 * 86_400_000 + 2, 14 * 86_400_000)).toBe(1)
  expect(Store.resourceUsage(0, 2_000).map((row) => row.ts)).toEqual([1_000, 1_000])
  console.log("resource store fresh: ok")
}
