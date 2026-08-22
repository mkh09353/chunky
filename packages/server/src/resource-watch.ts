// Periodic RAM/CPU sampler. Writes one server row plus one row per live
// background-task tree so /api/usage/resources can explain spikes (P50/P95/P99
// for machine sizing, plus the heaviest child commands at peak ticks).
//
// Failures are swallowed: sampling must never take down the server loop.
import { descendantPids } from "./process-tree.ts"
import { liveTrackedProcesses } from "./tasks.ts"
import type { ResourceSampleInput } from "./store.ts"
import type { ResourcePercentiles, ResourceUsageResponse } from "@chunky/protocol"

export const RESOURCE_SAMPLE_INTERVAL_MS = 20_000
export const RESOURCE_RETENTION_MS = 14 * 86_400_000

export type ResourceCommandResult = { exitCode: number; stdout: string }
export type ResourceCommandRunner = (command: string[]) => ResourceCommandResult

export type ResourceWatchContext = {
  activeSessions?: number | null
  liveTasks?: number | null
  liveDelegates?: number | null
}

export type ResourceWatchOptions = {
  persist?: (rows: ResourceSampleInput[]) => void
  context?: () => ResourceWatchContext
  now?: () => number
  memoryUsage?: () => { rss: number; heapUsed: number }
  cpuUsage?: () => { user: number; system: number }
  processes?: () => ReturnType<typeof liveTrackedProcesses>
  descendants?: (pid: number) => number[]
}

let runner: ResourceCommandRunner = defaultRunner
let timer: ReturnType<typeof setInterval> | undefined
let options: ResourceWatchOptions = {}
let lastCpu: { usage: { user: number; system: number }; at: number } | null = null

function defaultRunner(command: string[]): ResourceCommandResult {
  try {
    const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "ignore" })
    return { exitCode: result.exitCode, stdout: result.stdout.toString() }
  } catch {
    return { exitCode: 127, stdout: "" }
  }
}

/** Test-only command seam; restoring with no argument uses real subprocesses. */
export function setResourceCommandRunnerForTests(next?: ResourceCommandRunner): void {
  runner = next ?? defaultRunner
}

export function startResourceWatch(next: ResourceWatchOptions = {}): void {
  options = next
  if (timer) return
  timer = setInterval(() => { void sampleAndPersist() }, RESOURCE_SAMPLE_INTERVAL_MS)
  timer.unref?.()
}

export function stopResourceWatch(): void {
  if (timer) clearInterval(timer)
  timer = undefined
}

export function resetResourceWatchForTests(): void {
  stopResourceWatch()
  lastCpu = null
  options = {}
  runner = defaultRunner
}

function persistRows(rows: ResourceSampleInput[]): void {
  if (!rows.length) return
  try {
    const persist = options.persist ?? ((batch) => {
      // Lazy: importing store.ts opens the process sqlite connection.
      return import("./store.ts").then(({ Store }) => Store.logResourceSamples(batch)).catch((error) => {
        console.warn(`[@chunky/server] resource sample persist failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    })
    void persist(rows)
  } catch (error) {
    console.warn(`[@chunky/server] resource sample persist failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function sampleAndPersist(now = options.now?.() ?? Date.now()): ResourceSampleInput[] {
  try {
    const rows = collectResourceSamples(now)
    persistRows(rows)
    return rows
  } catch (error) {
    console.warn(`[@chunky/server] resource sample failed: ${error instanceof Error ? error.message : String(error)}`)
    return []
  }
}

function capCommand(command: string): string {
  return command.length <= 200 ? command : command.slice(0, 200)
}

/** Parse `ps -o pid,rss,pcpu` rows. Header and dead-pid noise are skipped. */
export function parsePsOutput(output: string): Map<number, { rssKb: number; pcpu: number }> {
  const found = new Map<number, { rssKb: number; pcpu: number }>()
  for (const line of output.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 3) continue
    const pid = Number(parts[0]), rssKb = Number(parts[1]), pcpu = Number(parts[2])
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isFinite(rssKb) || rssKb < 0 || !Number.isFinite(pcpu)) continue
    found.set(pid, { rssKb, pcpu })
  }
  return found
}

function readProcessStats(pids: number[]): Map<number, { rssKb: number; pcpu: number }> {
  if (!pids.length) return new Map()
  try {
    const result = runner(["ps", "-o", "pid,rss,pcpu", "-p", pids.join(",")])
    return parsePsOutput(result.stdout)
  } catch {
    return new Map()
  }
}

function cpuPercentSince(now: number, usage: { user: number; system: number }): number {
  const prev = lastCpu
  lastCpu = { usage, at: now }
  if (!prev) return 0
  const elapsedMs = now - prev.at
  if (elapsedMs <= 0) return 0
  const cpuMs = ((usage.user - prev.usage.user) + (usage.system - prev.usage.system)) / 1000
  if (!Number.isFinite(cpuMs) || cpuMs < 0) return 0
  return (cpuMs / elapsedMs) * 100
}

export function collectResourceSamples(now = options.now?.() ?? Date.now()): ResourceSampleInput[] {
  const memory = options.memoryUsage?.() ?? process.memoryUsage()
  const usage = options.cpuUsage?.() ?? process.cpuUsage()
  const cpuPercent = cpuPercentSince(now, usage)
  const processes = options.processes?.() ?? liveTrackedProcesses()
  const descendantsOf = options.descendants ?? descendantPids
  const context = (() => {
    try { return options.context?.() ?? {} } catch { return {} }
  })()
  const liveTasks = context.liveTasks ?? processes.length

  const rows: ResourceSampleInput[] = [{
    ts: now,
    scope: "server",
    pid: process.pid,
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    cpuPercent,
    activeSessions: context.activeSessions ?? null,
    liveTasks,
    liveDelegates: context.liveDelegates ?? null,
  }]

  const allPids = new Set<number>()
  const trees = processes.map((proc) => {
    let kids: number[] = []
    try { kids = descendantsOf(proc.pid) } catch { kids = [] }
    const pids = [proc.pid, ...kids].filter((pid) => Number.isInteger(pid) && pid > 0)
    for (const pid of pids) allPids.add(pid)
    return { proc, pids }
  })
  const stats = readProcessStats([...allPids])
  for (const { proc, pids } of trees) {
    let rssKb = 0, pcpu = 0
    for (const pid of pids) {
      const row = stats.get(pid)
      if (!row) continue
      rssKb += row.rssKb
      pcpu += row.pcpu
    }
    rows.push({
      ts: now,
      scope: "task",
      sessionId: proc.sessionId,
      taskId: proc.taskId,
      pid: proc.pid,
      rssBytes: Math.round(rssKb * 1024),
      cpuPercent: pcpu,
      command: capCommand(proc.command),
    })
  }
  return rows
}

/** Nearest-rank percentile. Empty input is 0 so empty windows stay well-typed. */
export function resourcePercentiles(values: number[]): ResourcePercentiles {
  if (!values.length) return { p50: 0, p95: 0, p99: 0, max: 0 }
  const sorted = [...values].sort((a, b) => a - b)
  const at = (p: number) => sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1))]!
  return { p50: at(50), p95: at(95), p99: at(99), max: sorted[sorted.length - 1]! }
}

function num(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

export function buildResourceUsageResponse(
  rows: ResourceSampleInput[],
  opts: { intervalMs?: number; windowMs: number },
): ResourceUsageResponse {
  const ticks = new Map<number, {
    ts: number
    serverRss: number
    serverHeap: number
    serverCpu: number
    childRss: number
    childCpu: number
    activeSessions: number | null
    liveTasks: number | null
    liveDelegates: number | null
    tasks: Array<{ taskId: string; sessionId: string; command: string; rssBytes: number }>
  }>()
  for (const row of rows) {
    let tick = ticks.get(row.ts)
    if (!tick) {
      tick = {
        ts: row.ts, serverRss: 0, serverHeap: 0, serverCpu: 0, childRss: 0, childCpu: 0,
        activeSessions: null, liveTasks: null, liveDelegates: null, tasks: [],
      }
      ticks.set(row.ts, tick)
    }
    if (row.scope === "server") {
      tick.serverRss = num(row.rssBytes)
      tick.serverHeap = num(row.heapUsedBytes)
      tick.serverCpu = num(row.cpuPercent)
      tick.activeSessions = row.activeSessions ?? null
      tick.liveTasks = row.liveTasks ?? null
      tick.liveDelegates = row.liveDelegates ?? null
    } else {
      const rss = num(row.rssBytes)
      tick.childRss += rss
      tick.childCpu += num(row.cpuPercent)
      tick.tasks.push({
        taskId: row.taskId ?? "",
        sessionId: row.sessionId ?? "",
        command: row.command ?? "",
        rssBytes: rss,
      })
    }
  }
  const samples = [...ticks.values()].sort((a, b) => a.ts - b.ts)
  const zero = resourcePercentiles([])
  if (!samples.length) {
    return {
      status: "ok",
      sampleCount: 0,
      intervalMs: opts.intervalMs ?? RESOURCE_SAMPLE_INTERVAL_MS,
      windowMs: opts.windowMs,
      server: { rssBytes: zero, cpuPercent: zero, current: { rssBytes: 0, heapUsedBytes: 0, cpuPercent: 0 } },
      children: { rssBytes: zero, cpuPercent: zero },
      total: { rssBytes: zero, cpuPercent: zero },
      peaks: [],
    }
  }
  const latest = samples[samples.length - 1]!
  const peaks = [...samples]
    .sort((a, b) => (a.serverRss + a.childRss) - (b.serverRss + b.childRss) || a.ts - b.ts)
    .slice(-5)
    .reverse()
    .map((tick) => ({
      ts: tick.ts,
      totalRssBytes: tick.serverRss + tick.childRss,
      serverRssBytes: tick.serverRss,
      cpuPercent: tick.serverCpu + tick.childCpu,
      activeSessions: tick.activeSessions,
      liveTasks: tick.liveTasks,
      liveDelegates: tick.liveDelegates,
      topTasks: [...tick.tasks].sort((a, b) => b.rssBytes - a.rssBytes || a.taskId.localeCompare(b.taskId)).slice(0, 3),
    }))
  return {
    status: "ok",
    sampleCount: samples.length,
    intervalMs: opts.intervalMs ?? RESOURCE_SAMPLE_INTERVAL_MS,
    windowMs: opts.windowMs,
    server: {
      rssBytes: resourcePercentiles(samples.map((s) => s.serverRss)),
      cpuPercent: resourcePercentiles(samples.map((s) => s.serverCpu)),
      current: { rssBytes: latest.serverRss, heapUsedBytes: latest.serverHeap, cpuPercent: latest.serverCpu },
    },
    children: {
      rssBytes: resourcePercentiles(samples.map((s) => s.childRss)),
      cpuPercent: resourcePercentiles(samples.map((s) => s.childCpu)),
    },
    total: {
      rssBytes: resourcePercentiles(samples.map((s) => s.serverRss + s.childRss)),
      cpuPercent: resourcePercentiles(samples.map((s) => s.serverCpu + s.childCpu)),
    },
    peaks,
  }
}
