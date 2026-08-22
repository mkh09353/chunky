import { afterEach, describe, expect, test } from "bun:test"
import {
  buildResourceUsageResponse,
  parsePsOutput,
  resetResourceWatchForTests,
  resourcePercentiles,
  sampleAndPersist,
  setResourceCommandRunnerForTests,
  startResourceWatch,
} from "./resource-watch.ts"
type ResourceSampleInput = {
  ts: number; scope: "server" | "task"; sessionId?: string | null; taskId?: string | null
  pid?: number | null; rssBytes: number; heapUsedBytes?: number | null; cpuPercent?: number | null
  activeSessions?: number | null; liveTasks?: number | null; liveDelegates?: number | null; command?: string | null
}

afterEach(() => { resetResourceWatchForTests() })

describe("parsePsOutput", () => {
  test("skips the header and keeps surviving pids when some have exited", () => {
    const parsed = parsePsOutput("  PID    RSS  %CPU\n  10   2048   1.5\n  11   1024   0.5\n")
    expect(parsed.get(10)).toEqual({ rssKb: 2048, pcpu: 1.5 })
    expect(parsed.get(11)).toEqual({ rssKb: 1024, pcpu: 0.5 })
    expect(parsePsOutput("  PID    RSS  %CPU\n").size).toBe(0)
  })
})

describe("resourcePercentiles", () => {
  test("returns zeros for an empty window and nearest-rank otherwise", () => {
    expect(resourcePercentiles([])).toEqual({ p50: 0, p95: 0, p99: 0, max: 0 })
    expect(resourcePercentiles([1])).toEqual({ p50: 1, p95: 1, p99: 1, max: 1 })
    expect(resourcePercentiles([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toEqual({ p50: 5, p95: 10, p99: 10, max: 10 })
    expect(resourcePercentiles([10, 20, 30, 40])).toEqual({ p50: 20, p95: 40, p99: 40, max: 40 })
  })
})

describe("sampleAndPersist", () => {
  test("writes a server row plus one row per tracked child tree via the injected runner", () => {
    const persisted: ResourceSampleInput[][] = []
    const seenPids: string[] = []
    let cpuUser = 1_000_000
    setResourceCommandRunnerForTests((command) => {
      expect(command.slice(0, 4)).toEqual(["ps", "-o", "pid,rss,pcpu", "-p"])
      seenPids.push(command[4] ?? "")
      // pid 101 died between enumeration and ps — still parse the live row.
      return { exitCode: 1, stdout: "  PID    RSS  %CPU\n  100   4096  12.0\n  200    512   3.0\n" }
    })
    startResourceWatch({
      persist: (rows) => persisted.push(rows),
      memoryUsage: () => ({ rss: 80_000_000, heapUsed: 20_000_000 }),
      cpuUsage: () => {
        const usage = { user: cpuUser, system: 500_000 }
        cpuUser += 4_000_000
        return usage
      },
      processes: () => [
        { sessionId: "s1", taskId: "task-1", kind: "bash", command: "npm run dev", pid: 100 },
        { sessionId: "s1", taskId: "task-2", kind: "monitor", command: "tail -f log", pid: 200 },
      ],
      descendants: (pid) => pid === 100 ? [101] : [],
      context: () => ({ activeSessions: 3, liveTasks: 2, liveDelegates: 1 }),
    })
    sampleAndPersist(1_000)
    const rows = sampleAndPersist(21_000)
    expect(rows).toHaveLength(3)
    expect(persisted).toHaveLength(2)
    expect(seenPids.some((value) => value.split(",").includes("100") && value.split(",").includes("101"))).toBe(true)
    const server = rows.find((row) => row.scope === "server")!
    expect(server).toMatchObject({
      ts: 21_000, rssBytes: 80_000_000, heapUsedBytes: 20_000_000,
      activeSessions: 3, liveTasks: 2, liveDelegates: 1,
    })
    expect(server.cpuPercent).toBe(20)
    const task = rows.find((row) => row.taskId === "task-1")!
    expect(task).toMatchObject({
      scope: "task", sessionId: "s1", pid: 100, command: "npm run dev",
      rssBytes: 4096 * 1024, cpuPercent: 12,
    })
    const monitor = rows.find((row) => row.taskId === "task-2")!
    expect(monitor).toMatchObject({ rssBytes: 512 * 1024, cpuPercent: 3 })
  })
})

describe("buildResourceUsageResponse", () => {
  test("zeroes an empty window and keeps status ok", () => {
    const body = buildResourceUsageResponse([], { windowMs: 86_400_000 })
    expect(body.status).toBe("ok")
    expect(body.sampleCount).toBe(0)
    expect(body.intervalMs).toBe(20_000)
    expect(body.windowMs).toBe(86_400_000)
    expect(body.server.rssBytes).toEqual({ p50: 0, p95: 0, p99: 0, max: 0 })
    expect(body.server.current).toEqual({ rssBytes: 0, heapUsedBytes: 0, cpuPercent: 0 })
    expect(body.children.rssBytes).toEqual({ p50: 0, p95: 0, p99: 0, max: 0 })
    expect(body.total.cpuPercent).toEqual({ p50: 0, p95: 0, p99: 0, max: 0 })
    expect(body.peaks).toEqual([])
  })

  test("aggregates children per tick and reports the heaviest peaks", () => {
    const rows: ResourceSampleInput[] = [
      { ts: 1, scope: "server", rssBytes: 100, heapUsedBytes: 10, cpuPercent: 1, activeSessions: 1, liveTasks: 1, liveDelegates: 0 },
      { ts: 1, scope: "task", sessionId: "s", taskId: "a", command: "light", rssBytes: 10, cpuPercent: 1 },
      { ts: 2, scope: "server", rssBytes: 200, heapUsedBytes: 20, cpuPercent: 2, activeSessions: 2, liveTasks: 2, liveDelegates: 1 },
      { ts: 2, scope: "task", sessionId: "s", taskId: "heavy", command: "vite", rssBytes: 80, cpuPercent: 4 },
      { ts: 2, scope: "task", sessionId: "s", taskId: "mid", command: "node", rssBytes: 40, cpuPercent: 2 },
      { ts: 2, scope: "task", sessionId: "s", taskId: "tiny", command: "tail", rssBytes: 5, cpuPercent: 0 },
      { ts: 2, scope: "task", sessionId: "s", taskId: "skip", command: "other", rssBytes: 1, cpuPercent: 0 },
      { ts: 3, scope: "server", rssBytes: 150, heapUsedBytes: 15, cpuPercent: 3, activeSessions: 1, liveTasks: 0, liveDelegates: 0 },
    ]
    const body = buildResourceUsageResponse(rows, { windowMs: 60_000, intervalMs: 20_000 })
    expect(body.sampleCount).toBe(3)
    expect(body.server.rssBytes).toEqual({ p50: 150, p95: 200, p99: 200, max: 200 })
    expect(body.children.rssBytes.max).toBe(126)
    expect(body.total.rssBytes.max).toBe(326)
    expect(body.server.current).toEqual({ rssBytes: 150, heapUsedBytes: 15, cpuPercent: 3 })
    expect(body.peaks[0]).toMatchObject({
      ts: 2, totalRssBytes: 326, serverRssBytes: 200, cpuPercent: 8,
      activeSessions: 2, liveTasks: 2, liveDelegates: 1,
    })
    expect(body.peaks[0]!.topTasks.map((task) => task.taskId)).toEqual(["heavy", "mid", "tiny"])
    expect(body.peaks).toHaveLength(3)
  })
})
