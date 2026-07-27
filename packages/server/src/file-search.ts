/** Resolve the workspace for an @-mention file search.
 *
 * A session is authoritative because it can be resumed or forked into a
 * worktree. Repo/default lookup remains for older callers that do not send one.
 */
export function resolveFileSearchWorkspace(
  sessionId: string | null,
  repoId: string | null,
  lookup: {
    workspaceOf(sessionId: string): string | null
    repoPath(repoId: string): string | null
    activeRepoPath(): string | null
  },
): { workspace: string | null } | { error: string; status: number } {
  // A present-but-empty value is invalid input, not permission to fall back to
  // a potentially unrelated default repository.
  if (sessionId !== null) {
    const workspace = lookup.workspaceOf(sessionId)
    if (!workspace) return { error: `unknown session "${sessionId}"`, status: 404 }
    return { workspace }
  }

  if (repoId) {
    const workspace = lookup.repoPath(repoId)
    if (!workspace) return { error: `unknown repo "${repoId}"`, status: 404 }
    return { workspace }
  }

  return { workspace: lookup.activeRepoPath() }
}
