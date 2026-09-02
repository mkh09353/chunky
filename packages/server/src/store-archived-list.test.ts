import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { createIsolatedTestState, removeIsolatedTestState } from "./test-state.ts"

const PREFIX = "chunky-archived-list-test-"
const state = createIsolatedTestState(PREFIX)
process.env.CHUNKY_DB = state.db
process.env.CHUNKY_SETTINGS = state.settings
process.env.CHUNKY_GRAPH_DB = join(state.root, "graph.db")
const { Store } = await import("./store.ts")
const { archiveSession, rehydrateSession } = await import("./session-archive.ts")
const { subscribeSessionChanges } = await import("./session-changes.ts")

beforeAll(() => mkdirSync(state.root, { recursive: true }))
afterAll(() => { delete process.env.CHUNKY_SETTINGS; removeIsolatedTestState(state.root, PREFIX) })

const ids = (rows: { sessionId: string }[]) => rows.map((s) => s.sessionId)

describe("live vs archived session lists", () => {
  test("list/listByWorkspaces are live-only; listArchived* are cold-only", async () => {
    const suffix = crypto.randomUUID(), repo = `/repo-${suffix}`, worktree = `/repo-${suffix}/.worktrees/wt`
    const liveRepo = `live-repo-${suffix}`, liveTree = `live-tree-${suffix}`, coldRepo = `cold-repo-${suffix}`, coldTree = `cold-tree-${suffix}`
    Store.createSession(liveRepo, "Live repo", repo)
    Store.createSession(liveTree, "Live tree", worktree)
    Store.createSession(coldRepo, "Cold repo", repo)
    Store.createSession(coldTree, "Cold tree", worktree)
    expect(await archiveSession(coldRepo)).toBe(true)
    expect(await archiveSession(coldTree)).toBe(true)

    const live = Store.list(repo)
    expect(ids(live)).toContain(liveRepo)
    expect(ids(live)).not.toContain(coldRepo)
    expect(live.some((s) => s.archived)).toBe(false)
    expect(ids(Store.list())).not.toContain(coldRepo)

    const liveSet = Store.listByWorkspaces([repo, worktree])
    expect(ids(liveSet)).toEqual(expect.arrayContaining([liveRepo, liveTree]))
    expect(ids(liveSet)).not.toContain(coldRepo)
    expect(ids(liveSet)).not.toContain(coldTree)

    const cold = Store.listArchived(repo)
    expect(ids(cold)).toEqual([coldRepo])
    expect(cold[0]).toMatchObject({ title: "Cold repo", workspace: repo, archived: true, incognito: false })
    expect(ids(Store.listArchived())).toEqual(expect.arrayContaining([coldRepo, coldTree]))
    expect(ids(Store.listArchived())).not.toContain(liveRepo)

    const coldSet = Store.listArchivedByWorkspaces([repo, worktree, repo])
    expect(ids(coldSet).sort()).toEqual([coldRepo, coldTree].sort())
    expect(coldSet.every((s) => s.archived === true)).toBe(true)
    const activity = coldSet.map((s) => s.lastActivity)
    expect(activity).toEqual([...activity].sort((a, b) => b - a))
    expect(Store.listArchivedByWorkspaces([])).toEqual([])
    expect(Store.listArchivedByWorkspaces([""])).toEqual([])
    expect(Store.listArchivedByWorkspaces([`/nothing-${suffix}`])).toEqual([])
  })

  test("listShell keeps cold rows for the mobile shell; listShellLive and liveSummary drop them", async () => {
    const suffix = crypto.randomUUID(), live = `shell-live-${suffix}`, cold = `shell-cold-${suffix}`
    Store.createSession(live, "Shell live", `/shell-${suffix}`)
    Store.createSession(cold, "Shell cold", `/shell-${suffix}`)
    expect(await archiveSession(cold)).toBe(true)

    expect(Store.listShell().find((s) => s.sessionId === cold)).toMatchObject({ archived: true })
    expect(ids(Store.listShell())).toContain(live)
    expect(ids(Store.listShellLive())).toContain(live)
    expect(ids(Store.listShellLive())).not.toContain(cold)
    expect(Store.listShellLive().some((s) => s.archived)).toBe(false)

    expect(Store.liveSummary(live)).toMatchObject({ sessionId: live, title: "Shell live" })
    expect(Store.liveSummary(live)?.archived).toBeUndefined()
    expect(Store.liveSummary(cold)).toBeNull()
    // Opening a cold session by id still resolves through the archived index.
    expect(Store.summary(cold)).toMatchObject({ sessionId: cold, title: "Shell cold", archived: true })
    expect(Store.summary(`missing-${suffix}`)).toBeNull()
  })

  test("archiving and restoring notify the session stream so it emits remove then upsert", async () => {
    const id = `notify-${crypto.randomUUID()}`
    Store.createSession(id, "Notify", `/notify-${id}`)
    const seen: string[] = []
    const unsubscribe = subscribeSessionChanges((sessionId) => seen.push(sessionId))
    try {
      seen.length = 0
      expect(await archiveSession(id)).toBe(true)
      // The stream maps a notified id through liveSummary: null -> `remove`.
      expect(seen).toContain(id)
      expect(Store.liveSummary(id)).toBeNull()
      expect(ids(Store.listArchived(`/notify-${id}`))).toEqual([id])

      seen.length = 0
      expect(await rehydrateSession(id)).toBe(true)
      // ...and a restored session resolves again: `upsert`.
      expect(seen).toContain(id)
      expect(Store.liveSummary(id)).toMatchObject({ sessionId: id, title: "Notify" })
      expect(Store.listArchived(`/notify-${id}`)).toEqual([])
      expect(ids(Store.list(`/notify-${id}`))).toEqual([id])
    } finally {
      unsubscribe()
    }
  })
})
