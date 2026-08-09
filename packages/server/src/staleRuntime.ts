// `chunky update` swaps the installed app directory while old servers are still
// alive. Loaded JS keeps serving, but the Agent SDK may later resolve a native
// binary through the replacement tree. Treat only that specific failure as
// evidence that this process must drain and restart.
const STALE_RUNTIME_ERROR = /native CLI binary .* not found/i

export function isStaleRuntimeError(error: unknown): boolean {
  const seen = new Set<unknown>()
  let current: unknown = error
  while (current != null && !seen.has(current)) {
    seen.add(current)
    const message = current instanceof Error
      ? `${current.message}\n${String(current)}`
      : String(current)
    if (STALE_RUNTIME_ERROR.test(message)) return true
    current = typeof current === "object" && "cause" in current
      ? (current as { cause?: unknown }).cause
      : undefined
  }
  return false
}

let staleRuntimeCallback: (() => void) | undefined
let staleRuntimeReported = false

export function onStaleRuntime(callback: () => void): void {
  staleRuntimeCallback = callback
}

/** Safe in terminal error paths: classification and the callback never escape. */
export function reportStaleRuntime(error: unknown): void {
  if (staleRuntimeReported) return
  try {
    if (!isStaleRuntimeError(error)) return
    staleRuntimeReported = true
    staleRuntimeCallback?.()
  } catch {
    // Retirement is best-effort; never replace the run's original error.
  }
}

/** Retire only when a successful disk read proves the installed version changed. */
export function checkInstalledVersion(
  startupVersion: string,
  readVersion: () => string | null,
  retire: (installedVersion: string) => void,
): void {
  let installed: string | null
  try {
    installed = readVersion()
  } catch {
    return
  }
  if (installed && installed !== startupVersion) retire(installed)
}
