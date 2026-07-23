import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { markSessionIncognito, clearIncognitoSessions, assertSelectionAllowed } from "./incognito.ts"
import { saveCustomProviders } from "./settings.ts"
import { resolveModel } from "./providers/registry.ts"
import { AuthStore } from "./providers/auth-store.ts"
import { durableDbPath, Store } from "./store.ts"
import { IncognitoCheckpointSaver, registerIncognitoThread } from "./bun-sqlite-saver.ts"

afterEach(() => clearIncognitoSessions())

test("dual store keeps incognito data out of durable sqlite", () => {
  const id = `incog-${crypto.randomUUID()}`
  markSessionIncognito(id, ["fake"])
  Store.createSession(id)
  Store.appendEvent(id, { type: "message.start" } as any)
  Store.startTurn(id, "hello", null)
  Store.logUsage({ sessionId: id, role: "lead", provider: "fake", model: "m", inputTokens: 1 })
  Store.createDelegation({ id: crypto.randomUUID(), sessionId: id, kind: "child", provider: "fake", model: "m", briefSnippet: "x" })
  Store.putTodos(id, [{ id: "t", text: "todo", done: false }] as any)
  expect(Store.history(id)).toHaveLength(1)
  expect(Store.list().some((s) => s.sessionId === id)).toBe(true)
  expect(Store.usageRows(id)).toHaveLength(1)
  // Store fixes its durable connection at module load. Other test modules may
  // subsequently swap and remove CHUNKY_DB paths, so inspect Store's actual
  // durable backing file rather than the mutable environment variable.
  const db = new Database(durableDbPath, { readonly: true })
  try {
    for (const table of ["sessions", "events", "session_turns", "usage_log", "delegations", "todos"]) {
      expect((db.query(`SELECT COUNT(*) n FROM ${table} WHERE ${table === "sessions" ? "id" : "session_id"}=?`).get(id) as any).n).toBe(0)
    }
  } finally {
    db.close()
  }
})

test("incognito checkpoint saver routes roots and prefixed threads", async () => {
  const root = `root-${crypto.randomUUID()}`
  registerIncognitoThread(root)
  const durable = { getTuple: async () => undefined } as any
  const memory = { getTuple: async () => ({ source: "memory" }) } as any
  const saver = new IncognitoCheckpointSaver(durable, memory)
  expect((await saver.getTuple({ configurable: { thread_id: root } } as any) as any).source).toBe("memory")
  expect((await saver.getTuple({ configurable: { thread_id: `${root}:advisor` } } as any) as any).source).toBe("memory")
  expect(await saver.getTuple({ configurable: { thread_id: "other" } } as any)).toBeUndefined()
})

describe("selection enforcement", () => {
  test("normal and incognito allowlist checks are loud", () => {
    saveCustomProviders([{ id: "incognito-only", label: "I", baseURL: "http://localhost", scope: "incognito", defaultModel: "m" }])
    AuthStore.set("incognito-only", { type: "api", key: "test-key" })
    markSessionIncognito("s", ["allowed"])
    expect(() => assertSelectionAllowed("s", { provider: "blocked" })).toThrow("not in incognito allowlist")
    expect(() => assertSelectionAllowed(null, { provider: "incognito-only" })).toThrow("incognito-only")
    expect(() => resolveModel({ provider: "incognito-only", model: "m" })).toThrow("incognito-only")
    markSessionIncognito("owner", ["incognito-only"])
    expect(() => resolveModel({ provider: "incognito-only", model: "m" }, "owner")).not.toThrow()
    saveCustomProviders([])
    AuthStore.remove("incognito-only")
  })
})
