import { describe, expect, test } from "bun:test"
import { resolveFileSearchWorkspace } from "./file-search.ts"

const lookup = {
  workspaceOf: (sessionId: string) => sessionId === "worktree-session" ? "/worktrees/feature" : null,
  repoPath: (repoId: string) => repoId === "default-repo" ? "/repos/default" : null,
  activeRepoPath: () => "/repos/default",
}

describe("resolveFileSearchWorkspace", () => {
  test("uses a session-pinned workspace instead of the different default repo", () => {
    expect(resolveFileSearchWorkspace("worktree-session", null, lookup)).toEqual({ workspace: "/worktrees/feature" })
  })

  test("keeps repo/default fallback for callers without a session", () => {
    expect(resolveFileSearchWorkspace(null, "default-repo", lookup)).toEqual({ workspace: "/repos/default" })
    expect(resolveFileSearchWorkspace(null, null, lookup)).toEqual({ workspace: "/repos/default" })
  })

  test("rejects an unknown supplied session rather than falling back", () => {
    expect(resolveFileSearchWorkspace("unknown", "default-repo", lookup)).toEqual({
      error: 'unknown session "unknown"',
      status: 404,
    })
  })
})
