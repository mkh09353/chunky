import { afterEach, describe, expect, test } from "bun:test"
import { Store } from "../store.ts"
import { installSessionBus, resetSessionBus } from "../session-bus.ts"
import { MAX_NOTE_BYTES, MAX_NOTES_PER_THREAD, notes, runNotes } from "./notes.ts"

const id = (prefix: string) => `${prefix}-${crypto.randomUUID()}`
afterEach(() => resetSessionBus())

describe("notes store", () => {
  test("CRUD, metadata, ordering, and case-insensitive line search", async () => {
    const sessionId = id("notes-store")
    Store.createSession(sessionId)
    Store.putNote(sessionId, sessionId, "old.md", "first\nNeedle here")
    await Bun.sleep(2)
    Store.putNote(sessionId, "child-1", "new.md", "other NEEDLE\nlast")
    expect(Store.getNote(sessionId, sessionId, "old.md")).toBe("first\nNeedle here")
    expect(Store.listNotes(sessionId).map((note) => note.path)).toEqual(["new.md", "old.md"])
    expect(Store.listNotes(sessionId, sessionId)).toMatchObject([{ threadId: sessionId, path: "old.md", bytes: 17, lines: 2 }])
    expect(Store.searchNotes(sessionId, undefined, "needle")).toMatchObject([
      { threadId: "child-1", path: "new.md", line: 1, text: "other NEEDLE" },
      { threadId: sessionId, path: "old.md", line: 2, text: "Needle here" },
    ])
    expect(Store.deleteNote(sessionId, sessionId, "old.md")).toBe(true)
    expect(Store.deleteNote(sessionId, sessionId, "old.md")).toBe(false)
    expect(Store.getNote(sessionId, sessionId, "old.md")).toBeNull()
  })

  test("notes survive rewind and model selection changes", () => {
    const sessionId = id("notes-survive")
    Store.createSession(sessionId)
    Store.putNote(sessionId, sessionId, "notes.md", "durable")
    const turn = Store.startTurn(sessionId, "work", null)
    Store.rewindTranscript(sessionId, turn, Store.turn(sessionId, turn)!.startEventSeq)
    Store.pinSelection(sessionId, { provider: "openai", model: "one" } as any)
    Store.pinSelection(sessionId, { provider: "codex", model: "two" } as any)
    expect(Store.getNote(sessionId, sessionId, "notes.md")).toBe("durable")
  })
})

describe("notes tool", () => {
  test("validates paths, performs actions, slices lines, and persists update events", async () => {
    const sessionId = id("notes-tool")
    Store.createSession(sessionId)
    installSessionBus({
      emitUserMessage() {},
      emitEvent: (target, event) => { Store.appendEvent(target, event) },
      emitLiveEvent() {},
      async dispatch() {},
      isRunning: () => false,
    })
    expect(await runNotes({ action: "write", path: "../bad", text: "x" }, sessionId, sessionId)).toContain("invalid notes path")
    expect(await runNotes({ action: "write", path: "work/notes.md", text: "one\ntwo" }, sessionId, sessionId)).toContain("Wrote")
    expect(await runNotes({ action: "append", path: "work/notes.md", text: "three" }, sessionId, sessionId)).toContain("Appended")
    expect(await runNotes({ action: "read", path: "work/notes.md", start_line: -2, end_line: -1 }, sessionId, sessionId)).toBe("# work/notes.md (3 lines, owner: lead)\ntwo\nthree")
    expect(await runNotes({ action: "list" }, sessionId, sessionId)).toContain("work/notes.md (3 lines")
    expect(await runNotes({ action: "search", query: "THREE" }, sessionId, sessionId)).toContain("work/notes.md:3: three")
    expect(Store.history(sessionId).filter((event) => event.type === "notes.update")).toHaveLength(2)
  })

  test("enforces byte and file limits", async () => {
    const sessionId = id("notes-limits")
    Store.createSession(sessionId)
    expect(await runNotes({ action: "write", text: "x".repeat(MAX_NOTE_BYTES + 1) }, sessionId, sessionId)).toContain("Start another notes file")
    for (let i = 0; i < MAX_NOTES_PER_THREAD; i++) Store.putNote(sessionId, sessionId, `n${i}.md`, "x")
    expect(await runNotes({ action: "write", path: "overflow.md", text: "x" }, sessionId, sessionId)).toContain("file limit reached")
    expect(await runNotes({ action: "write", path: "n0.md", text: "updated" }, sessionId, sessionId)).toContain("Wrote")
  })

  test("cross-thread reads/list/search work while writes to another owner are denied", async () => {
    const sessionId = id("notes-cross")
    Store.createSession(sessionId)
    Store.putNote(sessionId, "child-a", "findings.md", "shared evidence")
    expect(await runNotes({ action: "read", path: "findings.md", owner: "child-a" }, sessionId, sessionId)).toContain("owner: child-a)\nshared evidence")
    expect(await runNotes({ action: "list", all_threads: true }, sessionId, sessionId)).toContain("owner: child-a")
    expect(await runNotes({ action: "search", query: "evidence", all_threads: true }, sessionId, sessionId)).toContain("child-a:findings.md:1")
    expect(await runNotes({ action: "write", path: "findings.md", owner: "child-a", text: "overwrite" }, sessionId, sessionId)).toContain("writes are restricted")
    expect(Store.getNote(sessionId, "child-a", "findings.md")).toBe("shared evidence")
  })

  test("schema supplies defaults and rejects unknown actions", () => {
    expect(notes.schema.safeParse({ action: "read" }).success).toBe(true)
    expect(notes.schema.safeParse({ action: "delete" }).success).toBe(false)
  })
})
