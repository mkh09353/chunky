// The real, on-disk directory the agent's filesystem tools operate on. Every
// filesystem tool (DeepAgents' FilesystemBackend-driven read/write/edit/ls/glob/grep,
// and our own apply_patch) is rooted here, and none of them may escape it.
import { resolve } from "node:path"

export const WORKSPACE = resolve(process.env.CHUNKY_WORKSPACE || process.cwd())
