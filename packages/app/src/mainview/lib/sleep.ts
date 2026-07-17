/** Abortable sleep. Resolves after `ms`, or immediately when `signal` aborts —
 *  so a polling loop can be cancelled between ticks instead of running out its
 *  full deadline after the user has walked away. Never rejects: callers check
 *  `signal.aborted` themselves rather than catching an AbortError. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const finish = () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", finish)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    signal?.addEventListener("abort", finish)
  })
}
