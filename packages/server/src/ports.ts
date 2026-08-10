import type { ListeningPort } from "@chunky/protocol"
import { descendantPids } from "./process-tree.ts"

type TrackedTask = { taskId: string; pid: number }
type CommandResult = { exitCode: number; stdout: string }
export type PortCommandRunner = (command: string[]) => CommandResult
type PortEmitter = (sessionId: string, ports: ListeningPort[]) => void

const tasks = new Map<string, Map<string, TrackedTask>>()
const snapshots = new Map<string, ListeningPort[]>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()
const unchangedSince = new Map<string, number>()
let emitter: PortEmitter | null = null
let runner: PortCommandRunner = defaultRunner

function defaultRunner(command: string[]): CommandResult {
  try {
    const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "ignore" })
    return { exitCode: result.exitCode, stdout: result.stdout.toString() }
  } catch { return { exitCode: 127, stdout: "" } }
}

function endpoint(value: string): { address: string; port: number } | null {
  const match = value.trim().match(/^\[([^\]]+)\]:(\d+)$|^(.*):(\d+)$/)
  if (!match) return null
  const address = (match[1] ?? match[3] ?? "").trim()
  const port = Number(match[2] ?? match[4])
  return address && Number.isInteger(port) && port > 0 && port <= 65535 ? { address, port } : null
}
function suggestedUrl(address: string, port: number): string | null {
  const a = address.toLowerCase()
  return ["*", "0.0.0.0", "::", "::0", "localhost", "127.0.0.1", "::1"].includes(a) ? `http://localhost:${port}/` : null
}

/** Parse lsof's machine-readable `-Fpcn` records. */
export function parseLsofOutput(output: string, taskId: string): ListeningPort[] {
  const ports: ListeningPort[] = []
  let pid = 0, command = ""
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("p")) pid = Number(line.slice(1))
    else if (line.startsWith("c")) command = line.slice(1)
    else if (line.startsWith("n") && pid > 0) {
      const found = endpoint(line.slice(1))
      if (found) ports.push({ ...found, pid, command, taskId, url: suggestedUrl(found.address, found.port) })
    }
  }
  return ports
}

/** Parse `ss -ltnpH` rows and retain only processes owned by this task tree. */
export function parseSsOutput(output: string, taskId: string, ownedPids: ReadonlySet<number>): ListeningPort[] {
  const ports: ListeningPort[] = []
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue
    const found = endpoint(line.trim().split(/\s+/)[3] ?? "")
    if (!found) continue
    for (const match of line.matchAll(/\("([^"\\]+)"[^)]*?pid=(\d+)/g)) {
      const pid = Number(match[2])
      if (ownedPids.has(pid)) ports.push({ ...found, pid, command: match[1]!, taskId, url: suggestedUrl(found.address, found.port) })
    }
  }
  return ports
}

export function stablePorts(input: ListeningPort[]): ListeningPort[] {
  const sorted = [...input].sort((a, b) => a.port - b.port || a.pid - b.pid || a.address.localeCompare(b.address) || a.taskId.localeCompare(b.taskId))
  const seen = new Set<string>()
  return sorted.filter((port) => { const key = `${port.port}:${port.pid}`; if (seen.has(key)) return false; seen.add(key); return true })
}
function same(a: ListeningPort[], b: ListeningPort[]): boolean { return JSON.stringify(a) === JSON.stringify(b) }
function emitIfChanged(sessionId: string, next: ListeningPort[]): boolean {
  const stable = stablePorts(next), previous = snapshots.get(sessionId) ?? []
  if (snapshots.has(sessionId) && same(previous, stable)) return false
  snapshots.set(sessionId, stable); emitter?.(sessionId, stable); return true
}
function runLsof(task: TrackedTask, pids: number[]): ListeningPort[] {
  const result = runner(["lsof", "-a", "-iTCP", "-sTCP:LISTEN", "-P", "-n", "-p", pids.join(","), "-Fpcn"])
  return result.exitCode === 0 ? parseLsofOutput(result.stdout, task.taskId) : []
}
function detect(sessionId: string): ListeningPort[] {
  const tracked = tasks.get(sessionId); if (!tracked?.size) return []
  const all: ListeningPort[] = []
  const ss = process.platform === "linux" ? runner(["ss", "-ltnpH"]) : null
  for (const task of tracked.values()) {
    // Descendants are discovered live. A daemon reparented out of this tree cannot
    // be attributed without a process group, which background tasks do not yet have.
    const pids = [task.pid, ...descendantPids(task.pid)]
    if (ss?.exitCode === 0) all.push(...parseSsOutput(ss.stdout, task.taskId, new Set(pids)))
    else all.push(...runLsof(task, pids))
  }
  return stablePorts(all)
}
function schedule(sessionId: string, delay: number): void {
  const old = timers.get(sessionId); if (old) clearTimeout(old)
  if (!(tasks.get(sessionId)?.size)) { timers.delete(sessionId); return }
  const timer = setTimeout(() => { timers.delete(sessionId); void scanSessionPorts(sessionId) }, delay)
  timer.unref?.(); timers.set(sessionId, timer)
}
export async function scanSessionPorts(sessionId: string): Promise<ListeningPort[]> {
  if (!(tasks.get(sessionId)?.size)) return currentSessionPorts(sessionId)
  try {
    const changed = emitIfChanged(sessionId, detect(sessionId)), now = Date.now()
    if (changed || !unchangedSince.has(sessionId)) unchangedSince.set(sessionId, now)
    schedule(sessionId, now - (unchangedSince.get(sessionId) ?? now) >= 60_000 ? 10_000 : 3_000)
  } catch { schedule(sessionId, 3_000) }
  return currentSessionPorts(sessionId)
}
export function trackTaskPorts(sessionId: string, taskId: string, pid: number): void {
  let session = tasks.get(sessionId); if (!session) { session = new Map(); tasks.set(sessionId, session) }
  session.set(taskId, { taskId, pid }); unchangedSince.set(sessionId, Date.now()); schedule(sessionId, 100)
}
export function finishTaskPorts(sessionId: string, taskId: string): void {
  const session = tasks.get(sessionId); session?.delete(taskId)
  emitIfChanged(sessionId, (snapshots.get(sessionId) ?? []).filter((port) => port.taskId !== taskId))
  if (!session?.size) { tasks.delete(sessionId); unchangedSince.delete(sessionId); const timer = timers.get(sessionId); if (timer) clearTimeout(timer); timers.delete(sessionId) }
  else schedule(sessionId, 0)
}
export function clearSessionPorts(sessionId: string): void {
  const timer = timers.get(sessionId); if (timer) clearTimeout(timer)
  timers.delete(sessionId); tasks.delete(sessionId); unchangedSince.delete(sessionId); emitIfChanged(sessionId, [])
}
export function currentSessionPorts(sessionId: string): ListeningPort[] { return [...(snapshots.get(sessionId) ?? [])] }
export function installPortEmitter(next: PortEmitter): void { emitter = next }
export function resetPortTracking(): void { for (const timer of timers.values()) clearTimeout(timer); timers.clear(); tasks.clear(); snapshots.clear(); unchangedSince.clear() }
/** Test-only command seam; restoring with no argument uses real subprocesses. */
export function setPortCommandRunnerForTests(next?: PortCommandRunner): void { runner = next ?? defaultRunner }
