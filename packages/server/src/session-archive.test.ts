import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { gunzipSync, gzipSync } from "node:zlib"
import { join } from "node:path"
import { createIsolatedTestState, removeIsolatedTestState } from "./test-state.ts"

const PREFIX = "chunky-archive-test-"
const state = createIsolatedTestState(PREFIX)
process.env.CHUNKY_DB ||= state.db
process.env.CHUNKY_SETTINGS ||= state.settings
process.env.CHUNKY_GRAPH_DB ||= join(state.root, "graph.db")
const { Store, durableDbPath } = await import("./store.ts")
const { archiveSession, rehydrateSession, sweepArchives, ARCHIVE_AFTER_DAYS } = await import("./session-archive.ts")
const { sweepOrphanCheckpoints } = await import("./session-archive.ts")
const { saveAttachment } = await import("./attachments.ts")
const { stateDir } = await import("./repos.ts")
const { installSessionBus, resetSessionBus } = await import("./session-bus.ts")
const { sendToSessionTool } = await import("./tools/sessions.ts")
const { registerThread, unregisterThread } = await import("./thread-context.ts")
const { composePortablePrompt } = await import("./portable-handoff.ts")

beforeAll(() => mkdirSync(state.root, { recursive: true }))
afterAll(() => { delete process.env.CHUNKY_SETTINGS })

describe("session archival", () => {
  test("round-trips events, turns, goal, and attachments", async () => {
    const id = `roundtrip-${crypto.randomUUID()}`, now = Date.now()
    Store.createSession(id, "Archived", "/workspace")
    Store.appendEvent(id, { type: "message.user", text: "hello" })
    const turn = Store.startTurn(id, "hello", "commit")
    Store.completeTurn(id, turn, "checkpoint")
    Store.putGoal({ sessionId:id, objective:"done", status:"complete", mode:"direct", createdAt:now, updatedAt:now, turns:1, maxTurns:2 })
    const ref = saveAttachment(id, Buffer.from("image").toString("base64"), "image/png")
    const history = Store.historyWithSeq(id), turns = Store.turns(id), goal = Store.getGoal(id)
    const generation = Store.historyGeneration(id)
    expect(await archiveSession(id)).toBe(true)
    expect(Store.exists(id)).toBe(false)
    expect(Store.listShell().find((s) => s.sessionId === id)).toMatchObject({ title:"Archived", archived:true })
    expect(await rehydrateSession(id)).toBe(true)
    expect(Store.historyWithSeq(id)).toEqual(history)
    expect(Store.historyGeneration(id)).toBe(generation)
    expect(Store.turns(id)).toEqual(turns)
    expect(Store.getGoal(id)).toEqual(goal)
    expect(readFileSync(ref.path, "utf8")).toBe("image")
    expect(await rehydrateSession(id)).toBe(true)
  })

  test("rehydrated history composes a portable handoff when its checkpoint is missing", async () => {
    const id = `portable-resume-${crypto.randomUUID()}`
    Store.createSession(id)
    Store.appendEvent(id, { type:"message.user", text:"remember this question" })
    Store.appendEvent(id, { type:"message.start", role:"assistant" } as any)
    Store.appendEvent(id, { type:"message.delta", text:"remember this answer" } as any)
    Store.appendEvent(id, { type:"message.end" } as any)
    expect(await archiveSession(id)).toBe(true)
    expect(await rehydrateSession(id)).toBe(true)

    const prompt = composePortablePrompt(
      "continue",
      "langgraph",
      "langgraph",
      Store.recentHistoryWithSeq(id, 200),
      true,
    )
    expect(prompt).toContain("[PORTABLE HISTORICAL TRANSCRIPT")
    expect(prompt).toContain("remember this question")
    expect(prompt).toContain("remember this answer")
    expect(prompt.endsWith("\n\ncontinue")).toBe(true)
  })

  test("old archive headers without a generation receive a fresh one", async () => {
    const id = `legacy-archive-${crypto.randomUUID()}`
    Store.createSession(id)
    const oldGeneration = Store.historyGeneration(id)
    expect(await archiveSession(id)).toBe(true)
    const path = join(stateDir(), "archive", `${id}.jsonl.gz`)
    const lines = gunzipSync(readFileSync(path)).toString("utf8").split("\n")
    const header = JSON.parse(lines[0]!)
    delete header.historyGeneration
    lines[0] = JSON.stringify(header)
    const bytes = gzipSync(lines.join("\n"))
    writeFileSync(path, bytes)
    const db = new (await import("bun:sqlite")).Database(durableDbPath)
    db.query("UPDATE archived_sessions SET byte_length=?,sha256=? WHERE id=?").run(bytes.byteLength, createHash("sha256").update(bytes).digest("hex"), id)
    db.close()
    expect(await rehydrateSession(id)).toBe(true)
    expect(Store.historyGeneration(id)).not.toBe(oldGeneration)
    expect(Store.historyGeneration(id)).not.toBe("")
  })

  test("sweep obeys age, running, and active-goal exclusions", async () => {
    const old = Date.now() - (ARCHIVE_AFTER_DAYS + 1) * 86_400_000
    const suffix = crypto.randomUUID(), eligible = `eligible-${suffix}`, running = `running-${suffix}`, goal = `goal-${suffix}`
    for (const id of [eligible, running, goal]) { Store.createSession(id); Store.appendEvent(id, { type:"message.user", text:id }) }
    const db = new (await import("bun:sqlite")).Database(durableDbPath)
    db.query("UPDATE sessions SET last_activity=? WHERE id IN (?,?,?)").run(old, eligible, running, goal)
    Store.putGoal({ sessionId:goal, objective:"live", status:"active", mode:"direct", createdAt:old, updatedAt:old, turns:0, maxTurns:2 })
    const swept = await sweepArchives(Date.now(), new Set([running]))
    expect(swept).toContain(eligible)
    expect(Store.exists(running)).toBe(true); expect(Store.exists(goal)).toBe(true)
  })

  test("publishes only completed archive files", async () => {
    const id = `atomic-${crypto.randomUUID()}`
    Store.createSession(id)
    expect(await archiveSession(id)).toBe(true)
    const dir = join(stateDir(), "archive")
    expect(existsSync(join(dir, `${id}.jsonl.gz`))).toBe(true)
    expect(existsSync(join(dir, `${id}.jsonl.gz.tmp`))).toBe(false)
  })

  test("archive deletes root and spawned-thread checkpoints; orphan sweep is repeatable", async () => {
    const id = `checkpoints-${crypto.randomUUID()}`, child = `child-${crypto.randomUUID()}`
    Store.createSession(id)
    Store.appendEvent(id, { type:"thread.spawn", threadId:child, parentThreadId:null, title:"child" } as any)
    const { BunSqliteSaver } = await import("./bun-sqlite-saver.ts")
    const saver = BunSqliteSaver.fromConnString(process.env.CHUNKY_GRAPH_DB!)
    for (const thread of [id, child, "orphan"]) await saver.put(
      { configurable:{ thread_id:thread } },
      { v:4, id:"cp", ts:"", channel_values:{}, channel_versions:{}, versions_seen:{} } as any,
      {} as any,
    )
    await archiveSession(id)
    const graph = new (await import("bun:sqlite")).Database(process.env.CHUNKY_GRAPH_DB!)
    expect((graph.query("SELECT count(*) n FROM checkpoints WHERE thread_id IN (?,?)").get(id,child) as any).n).toBe(0)
    expect(await sweepOrphanCheckpoints()).toBe(1)
    expect(await sweepOrphanCheckpoints()).toBe(0)
  })

  test("orphan sweep preserves child threads referenced by live sessions", async () => {
    const session = `live-child-parent-${crypto.randomUUID()}`
    const referenced = `child-${crypto.randomUUID()}`, orphan = `child-${crypto.randomUUID()}`
    Store.createSession(session)
    Store.appendEvent(session, { type:"thread.spawn", threadId:referenced, parentThreadId:null, title:"child" } as any)
    const { BunSqliteSaver } = await import("./bun-sqlite-saver.ts")
    const saver = BunSqliteSaver.fromConnString(process.env.CHUNKY_GRAPH_DB!)
    for (const thread of [referenced, orphan]) await saver.put(
      { configurable:{ thread_id:thread } },
      { v:4, id:"cp", ts:"", channel_values:{}, channel_versions:{}, versions_seen:{} } as any,
      {} as any,
    )

    expect(await sweepOrphanCheckpoints()).toBe(1)

    const graph = new (await import("bun:sqlite")).Database(process.env.CHUNKY_GRAPH_DB!)
    expect((graph.query("SELECT count(*) n FROM checkpoints WHERE thread_id=?").get(referenced) as any).n).toBe(1)
    expect((graph.query("SELECT count(*) n FROM checkpoints WHERE thread_id=?").get(orphan) as any).n).toBe(0)
    graph.close()
  })

  test("archive sweep removes orphan graph rows and events but preserves protected threads", async () => {
    const suffix = crypto.randomUUID()
    const live = `live-${suffix}`, archived = `archived-${suffix}`, activeGoal = `goal-${suffix}`, running = `running-${suffix}`
    Store.createSession(live)
    Store.createSession(archived)
    Store.createSession(activeGoal)
    Store.putGoal({ sessionId:activeGoal, objective:"live", status:"active", mode:"direct", createdAt:Date.now(), updatedAt:Date.now(), turns:0, maxTurns:2 })
    expect(await archiveSession(archived)).toBe(true)

    const { BunSqliteSaver } = await import("./bun-sqlite-saver.ts")
    const saver = BunSqliteSaver.fromConnString(process.env.CHUNKY_GRAPH_DB!)
    const orphan = `orphan-${suffix}`
    for (const thread of [`${live}:sidekick`, `${archived}:tui`, `${activeGoal}:other-seat`, `${running}:sidekick`, orphan]) await saver.put(
      { configurable:{ thread_id:thread } },
      { v:4, id:"cp", ts:"", channel_values:{}, channel_versions:{}, versions_seen:{} } as any,
      {} as any,
    )
    const graph = new (await import("bun:sqlite")).Database(process.env.CHUNKY_GRAPH_DB!)
    graph.query("INSERT INTO checkpoint_anchors VALUES (?,?,?)").run(orphan, "cp", 1)
    graph.query("INSERT OR REPLACE INTO writes VALUES (?,?,?,?,?,?,?,?)").run(orphan, "", "cp", "task", 0, "channel", "json", "value")
    const db = new (await import("bun:sqlite")).Database(durableDbPath)
    const orphanEvent = `event-orphan-${suffix}`
    db.query("INSERT INTO events VALUES (?,?,?)").run(orphanEvent, 0, JSON.stringify({ type:"message.user", text:"orphan" }))
    db.query("INSERT INTO session_turns VALUES (?,?,?,?,?,?,?,?,?,?)").run(orphanEvent, 0, 0, null, null, null, "orphan", "running", Date.now(), null)
    db.close()

    await sweepArchives(Date.now(), new Set([running]))

    expect((graph.query("SELECT count(*) n FROM checkpoints WHERE thread_id=?").get(orphan) as any).n).toBe(0)
    expect((graph.query("SELECT count(*) n FROM writes WHERE thread_id=?").get(orphan) as any).n).toBe(0)
    expect((graph.query("SELECT count(*) n FROM checkpoint_anchors WHERE thread_id=?").get(orphan) as any).n).toBe(0)
    for (const thread of [`${live}:sidekick`, `${archived}:tui`, `${activeGoal}:other-seat`, `${running}:sidekick`]) {
      expect((graph.query("SELECT count(*) n FROM checkpoints WHERE thread_id=?").get(thread) as any).n).toBe(1)
    }
    expect(Store.history(orphanEvent)).toEqual([])
    const durable = new (await import("bun:sqlite")).Database(durableDbPath)
    expect((durable.query("SELECT count(*) n FROM session_turns WHERE session_id=?").get(orphanEvent) as any).n).toBe(0)
    durable.close()
    graph.close()
  })

  test("archive sweep vacuums a bloated graph database", async () => {
    const graph = new (await import("bun:sqlite")).Database(process.env.CHUNKY_GRAPH_DB!)
    graph.exec("CREATE TABLE IF NOT EXISTS archive_vacuum_probe (value BLOB)")
    graph.query("INSERT INTO archive_vacuum_probe VALUES (zeroblob(?))").run(52 * 1024 * 1024)
    graph.query("DELETE FROM archive_vacuum_probe").run()
    const before = (graph.query("PRAGMA freelist_count").get() as { freelist_count: number }).freelist_count
    expect(before * (graph.query("PRAGMA page_size").get() as { page_size: number }).page_size).toBeGreaterThan(50 * 1024 * 1024)
    graph.close()

    await sweepArchives()

    const vacuumed = new (await import("bun:sqlite")).Database(process.env.CHUNKY_GRAPH_DB!)
    expect((vacuumed.query("PRAGMA freelist_count").get() as { freelist_count: number }).freelist_count).toBeLessThan(before)
    vacuumed.close()
  })

  test("send_to_session single-flight rehydrates an archived target and delivers concurrent messages", async () => {
    const sender = `sender-${crypto.randomUUID()}`, target = `target-${crypto.randomUUID()}`
    Store.createSession(sender, "Sender"); Store.createSession(target, "Target")
    Store.appendEvent(target, { type:"message.user", text:"before archive" })
    await archiveSession(target)
    let prepares = 0
    const delivered: string[] = []
    installSessionBus({
      async prepareSession(id) { prepares++; return rehydrateSession(id) },
      emitUserMessage(_id, text) { delivered.push(text) },
      emitEvent() {}, emitLiveEvent() {},
      async dispatch() {}, isRunning() { return false },
    })
    registerThread(sender, { sessionId:sender, spawn:async()=>"", consultAdvisor:async()=>"", delegateToSidekick:async()=>"", runWorkflow:async()=>"" })
    const config = { configurable:{ thread_id:sender } }
    const [a,b] = await Promise.all([
      sendToSessionTool.invoke({ session_id:target, message:"one" }, config),
      sendToSessionTool.invoke({ session_id:target, message:"two" }, config),
    ])
    expect(String(a)).toContain("Delivered")
    expect(String(b)).toContain("Delivered")
    expect(delivered.sort()).toEqual(["one","two"])
    expect(Store.exists(target)).toBe(true)
    expect(Store.history(target)).toContainEqual({ type:"message.user", text:"before archive" })
    // Tool calls may each enter prepareSession, but the archive module itself
    // guarantees both callers share one restore operation.
    expect(prepares).toBeGreaterThanOrEqual(1)
    unregisterThread(sender); resetSessionBus()
  })

  test("verifies archive size and hash and keeps the pointer on corruption", async () => {
    const id = `corrupt-${crypto.randomUUID()}`
    Store.createSession(id); Store.appendEvent(id, { type:"message.user", text:"preserve" })
    await archiveSession(id)
    const db = new (await import("bun:sqlite")).Database(durableDbPath)
    const pointer = db.query("SELECT byte_length,sha256 FROM archived_sessions WHERE id=?").get(id) as any
    expect(pointer.byte_length).toBeGreaterThan(0)
    expect(pointer.sha256).toMatch(/^[a-f0-9]{64}$/)
    writeFileSync(join(stateDir(), "archive", `${id}.jsonl.gz`), "corrupt")
    await expect(rehydrateSession(id)).rejects.toThrow("archive integrity check failed")
    expect(Store.isArchived(id)).toBe(true)
    expect(Store.exists(id)).toBe(false)
  })
})
