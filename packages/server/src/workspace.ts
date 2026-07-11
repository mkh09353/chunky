// Workspace resolution. There is NO mutable global workspace: every session
// stores its own workspace path (Store), every run threads it through LangGraph's
// `configurable` (run.ts / threads.ts / anthropic-runner.ts), and every tool
// resolves it per-call via workspaceFromConfig. That's what lets sessions in
// different repos run concurrently on one server — an in-flight run can never be
// retargeted by another client switching folders.
import { resolve } from "node:path"

/** The directory the server was launched in — the default workspace for
 *  sessions created without an explicit repo, and the guaranteed fallback for
 *  anything that predates per-session workspaces. */
export const LAUNCH_WORKSPACE = resolve(process.env.CHUNKY_WORKSPACE || process.cwd())

/**
 * The workspace for the run a tool is executing inside. Tools receive the
 * LangGraph RunnableConfig as their 2nd argument; run dispatch puts the session's
 * workspace in `configurable.workspace`. Falls back to LAUNCH_WORKSPACE for
 * direct invocations (tests, ad-hoc use) that carry no run config.
 */
export function workspaceFromConfig(config: unknown): string {
  const ws = (config as { configurable?: { workspace?: unknown } } | undefined)?.configurable
    ?.workspace
  return typeof ws === "string" && ws.length > 0 ? resolve(ws) : LAUNCH_WORKSPACE
}
