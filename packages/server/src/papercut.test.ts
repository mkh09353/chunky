import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { clearIncognitoSessions, markSessionIncognito } from "./incognito.ts"
import { filterPapercuts, formatPapercuts, parsePapercutLines, parsePapercutsArgs } from "./papercuts-cli.ts"
import { Store } from "./store.ts"
import { papercut } from "./tools/papercut.ts"

const root = mkdtempSync(join(tmpdir(), "chunky-papercut-"))
const workspace = join(root, "workspace")

afterAll(() => { clearIncognitoSessions() })

describe("papercut tool", () => {
  test("appends valid JSONL with server metadata", async () => {
    const sessionId = `papercut-${Date.now()}`
    Store.createSession(sessionId, "papercut test", workspace)
    Store.pinSelection(sessionId, { provider: "codex", model: "gpt-test" })
    expect(await papercut.invoke(
      { text: "The helper returned a confusing empty result.", category: "tooling" },
      { configurable: { thread_id: sessionId, papercuts_state_dir: join(root, "state") } },
    )).toBe("Noted.")

    const lines = readFileSync(join(root, "state", "papercuts.jsonl"), "utf8").trim().split("\n")
    const entry = JSON.parse(lines.at(-1)!)
    expect(entry).toMatchObject({
      model: "gpt-test",
      sessionId,
      workspace,
      text: "The helper returned a confusing empty result.",
      category: "tooling",
    })
    expect(new Date(entry.timestamp).toISOString()).toBe(entry.timestamp)
  })

  test("incognito sessions skip persistence", async () => {
    const before = readFileSync(join(root, "state", "papercuts.jsonl"), "utf8")
    const sessionId = `papercut-private-${Date.now()}`
    markSessionIncognito(sessionId, [])
    Store.createSession(sessionId, "private papercut", workspace)
    expect(await papercut.invoke({ text: "This must stay private." }, { configurable: { thread_id: sessionId, papercuts_state_dir: join(root, "state") } })).toBe("Noted.")
    expect(readFileSync(join(root, "state", "papercuts.jsonl"), "utf8")).toBe(before)
  })

  test("storage failure is swallowed", async () => {
    const blocked = join(root, "not-a-directory")
    writeFileSync(blocked, "file")
    const sessionId = `papercut-failure-${Date.now()}`
    Store.createSession(sessionId, "failed papercut", workspace)
    expect(await papercut.invoke({ text: "Storage is unavailable." }, { configurable: { thread_id: sessionId, papercuts_state_dir: blocked } })).toBe("Noted.")
  })
})

describe("papercuts CLI helpers", () => {
  const now = Date.parse("2026-08-12T12:00:00.000Z")
  const firstWorkspace = resolve(workspace)
  const otherWorkspace = resolve(root, "other")
  const lines = [
    JSON.stringify({ timestamp: "2026-08-10T12:00:00.000Z", model: "old", sessionId: "1", workspace: firstWorkspace, text: "Old complaint." }),
    "not json",
    JSON.stringify({ timestamp: "2026-08-12T06:00:00.000Z", model: "new", sessionId: "2", workspace: firstWorkspace, text: "Recent complaint." }),
    JSON.stringify({ timestamp: "2026-08-12T10:00:00.000Z", model: "other", sessionId: "3", workspace: otherWorkspace, text: "Other workspace." }),
  ].join("\n")

  test("parses --since and --workspace and filters malformed lines", () => {
    const options = parsePapercutsArgs(["--since", "24h", "--workspace", firstWorkspace], now)
    const filtered = filterPapercuts(parsePapercutLines(lines), options)
    expect(filtered.map(({ entry }) => entry.text)).toEqual(["Recent complaint."])
  })

  test("formats oldest-to-newest readable and raw JSONL output", () => {
    const entries = parsePapercutLines(lines)
    const readable = formatPapercuts(entries)
    expect(readable.indexOf("Old complaint.")).toBeLessThan(readable.indexOf("Recent complaint."))
    expect(readable).toContain("2026-08-12T06:00:00.000Z — new — workspace")
    expect(formatPapercuts(entries, true).split("\n")).toHaveLength(3)
  })

  test("handles empty files gracefully", () => {
    expect(formatPapercuts(parsePapercutLines(""))).toBe("No papercuts. Nice.")
  })
})
