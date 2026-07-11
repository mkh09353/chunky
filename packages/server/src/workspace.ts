// The real, on-disk directory the agent's filesystem tools operate on. Every
// tool (read / bash / write / edit and apply_patch) is rooted here, and none of
// them may escape it (see tools/fs-util.ts's resolveInWorkspace).
//
// WORKSPACE is a *live* binding, not a frozen const: switching repos in the GUI
// calls setWorkspace() to retarget it at runtime. ES module live bindings mean
// every `import { WORKSPACE }` importer sees the new value on its next read (all
// tools read it inside their execute functions, so they pick it up immediately).
// Callers that cache derived state MUST refresh on switch: the repo switcher
// invalidates the agent cache (prompt embeds the cwd) and getFinder() rebuilds
// its index when the base path changes.
import { resolve } from "node:path"

export let WORKSPACE = resolve(process.env.CHUNKY_WORKSPACE || process.cwd())

/** The directory the server was launched in — captured once and never mutated.
 *  The repo registry uses it as the guaranteed, un-removable fallback repo
 *  (WORKSPACE itself moves as repos are switched, so it can't serve that role). */
export const LAUNCH_WORKSPACE = WORKSPACE

/** Retarget the workspace root. Returns the resolved absolute path. */
export function setWorkspace(path: string): string {
  WORKSPACE = resolve(path)
  return WORKSPACE
}

/** Current workspace root (function form for callers that prefer a getter). */
export function getWorkspace(): string {
  return WORKSPACE
}
