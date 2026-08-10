/** Snapshot and terminate a process tree, matching foreground bash timeout behavior. */
export function descendantPids(rootPid: number): number[] {
  const found: number[] = []
  const visit = (parent: number) => {
    let result: ReturnType<typeof Bun.spawnSync>
    try { result = Bun.spawnSync(["pgrep", "-P", String(parent)], { stdout: "pipe", stderr: "ignore" }) } catch { return }
    const children = (result.stdout?.toString() ?? "").split(/\s+/).map(Number).filter((pid) => Number.isInteger(pid) && pid > 0)
    for (const child of children) { visit(child); found.push(child) }
  }
  visit(rootPid)
  return found
}
function signal(pids: number[], value: NodeJS.Signals): void {
  for (const pid of pids) { try { process.kill(pid, value) } catch {} }
}
export function terminateProcessTree(rootPid: number): void {
  const pids = [...descendantPids(rootPid), rootPid]
  signal(pids, "SIGTERM")
  const timer = setTimeout(() => signal(pids, "SIGKILL"), 250)
  timer.unref?.()
}
