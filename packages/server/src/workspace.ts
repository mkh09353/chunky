// The real, on-disk directory the agent's filesystem tools operate on. Every
// tool (read / bash / write / edit and apply_patch) is rooted here, and none of
// them may escape it (see tools/fs-util.ts's resolveInWorkspace).
import { resolve } from "node:path"

export const WORKSPACE = resolve(process.env.CHUNKY_WORKSPACE || process.cwd())
