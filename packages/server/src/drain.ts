// Graceful retirement for a superseded server.
//
// When a launcher installs a newer runtime it starts a server for the new
// build and hands the old one its retirement notice by deleting its discovery
// record (see startOwnershipPoller). Killing that server outright would abort
// whatever the user is running, so instead it DRAINS: it refuses work that
// would start a NEW turn, lets in-flight runs finish, keeps attached SSE
// clients streaming until the very end, and only then exits.
//
// Attached-but-idle clients must never keep a superseded server alive — a
// desktop app that sits open all day would pin the old build forever — so the
// drain gate is in-flight RUNS only, bounded by a timeout after which the
// remaining runs are aborted.

/** How long in-flight runs may keep a superseded server alive. */
export const DRAIN_TIMEOUT_MS = 5 * 60_000
/** How often the drain re-checks whether it can finish. */
export const DRAIN_POLL_MS = 1_000
/** Sent to clients that try to start new work on a retiring server. */
export const DRAIN_REFUSAL =
  "This Chunky server was replaced by a newer build and is finishing its in-flight work. Reconnect to pick up the new server."

export type DrainVerdict =
  /** Not draining; nothing to do. */
  | "idle"
  /** Draining, but work is still in flight and the timeout has not elapsed. */
  | "wait"
  /** Abort the remaining runs: they outlasted the drain timeout. */
  | "force"
  /** Nothing left to wait for — shut down. */
  | "finish"

export interface DrainSnapshot {
  retiring: boolean
  since: number | null
  deadline: number | null
}

/**
 * The drain state machine. Pure and clock-injected so the policy is testable
 * without booting a server: the caller owns the timer, the run registry and
 * the actual shutdown.
 */
export class DrainCoordinator {
  private startedAt: number | null = null
  private forced = false

  constructor(
    private readonly now: () => number = Date.now,
    private readonly timeoutMs: number = DRAIN_TIMEOUT_MS,
  ) {}

  /** True once retirement has begun — routes use this to refuse new turns. */
  get draining(): boolean {
    return this.startedAt !== null
  }

  /** Begin draining. Returns false when it was already under way. */
  begin(): boolean {
    if (this.startedAt !== null) return false
    this.startedAt = this.now()
    return true
  }

  /** Milliseconds until in-flight runs are aborted (null when not draining). */
  remainingMs(): number | null {
    if (this.startedAt === null) return null
    return Math.max(0, this.startedAt + this.timeoutMs - this.now())
  }

  /**
   * What the drain loop should do, given how many runs are still in flight.
   * "force" is returned at most once: after the caller has aborted, the next
   * evaluation finishes rather than waiting on a run that refused to die.
   */
  evaluate(runningCount: number): DrainVerdict {
    if (this.startedAt === null) return "idle"
    if (runningCount <= 0) return "finish"
    if (this.now() - this.startedAt < this.timeoutMs) return "wait"
    if (!this.forced) {
      this.forced = true
      return "force"
    }
    return "finish"
  }

  /** Identity payload for clients deciding whether to keep using this server. */
  snapshot(): DrainSnapshot {
    return {
      retiring: this.draining,
      since: this.startedAt,
      deadline: this.startedAt === null ? null : this.startedAt + this.timeoutMs,
    }
  }
}

export interface DrainLoopDeps {
  /** How many turns are still in flight right now. */
  runningCount(): number
  /** Abort those turns (called once, only after the drain timeout). */
  abortAll(): void
  /** Release the registration and shut the server down. */
  finish(): void
  log?(message: string): void
}

/**
 * One iteration of the drain loop, kept here so the retirement policy is
 * testable without a live server: the caller supplies the timer, the run
 * registry and the shutdown. Returns true when the loop is done.
 */
export function drainStep(coordinator: DrainCoordinator, deps: DrainLoopDeps): boolean {
  const verdict = coordinator.evaluate(deps.runningCount())
  if (verdict === "wait") return false
  if (verdict === "force") {
    deps.log?.(`drain timeout reached; aborting ${deps.runningCount()} in-flight run(s)`)
    deps.abortAll()
    return false
  }
  // "finish", or "idle" (never draining in the first place): stop the loop.
  if (verdict === "finish") deps.finish()
  return true
}
