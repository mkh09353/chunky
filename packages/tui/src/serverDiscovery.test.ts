// Finding the replacement server after ours is superseded.
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  findWorkspaceServer,
  orderCandidates,
  readRecords,
  type DiscoveredRecord,
  type DiscoveryDeps,
} from "./serverDiscovery.js"

function record(port: number, workspace: string, startedAt: number, version = "1"): DiscoveredRecord {
  return { id: `id-${port}`, workspace, version, port, startedAt }
}

describe("orderCandidates", () => {
  test("keeps only this workspace, newest first", () => {
    const records = [
      record(1, "/other", 10),
      record(2, "/wanted", 1),
      record(3, "/wanted", 5),
    ]
    expect(orderCandidates(records, "/wanted").map((r) => r.port)).toEqual([3, 2])
  })

  test("can exclude the port we just failed against", () => {
    const records = [record(2, "/wanted", 1), record(3, "/wanted", 5)]
    expect(orderCandidates(records, "/wanted", 3).map((r) => r.port)).toEqual([2])
  })

  test("no records for the workspace is not an error", () => {
    expect(orderCandidates([record(1, "/other", 1)], "/wanted")).toEqual([])
  })
})

describe("readRecords", () => {
  test("skips malformed files and missing directories", () => {
    const dir = mkdtempSync(join(tmpdir(), "chunky-tui-discovery-"))
    try {
      mkdirSync(join(dir, "servers"))
      writeFileSync(join(dir, "servers", "good.json"), JSON.stringify(record(4321, "/w", 7)))
      writeFileSync(join(dir, "servers", "bad.json"), "{{{")
      writeFileSync(join(dir, "servers", "partial.json"), JSON.stringify({ port: 1 }))
      writeFileSync(join(dir, "servers", "notes.txt"), "ignored")

      expect(readRecords(join(dir, "servers")).map((r) => r.port)).toEqual([4321])
      expect(readRecords(join(dir, "nope"))).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("findWorkspaceServer", () => {
  function deps(records: DiscoveredRecord[], live: Record<number, { ok: boolean; retiring?: boolean }>): DiscoveryDeps {
    return {
      readRecords: () => records,
      probe: async (port) => ({
        ok: live[port]?.ok ?? false,
        retiring: live[port]?.retiring ?? false,
      }),
    }
  }

  test("returns the newest healthy server for the workspace", async () => {
    const records = [record(11, "/wanted", 1), record(12, "/wanted", 9)]
    const found = await findWorkspaceServer("/wanted", undefined, deps(records, { 11: { ok: true }, 12: { ok: true } }))
    expect(found).toBe("http://localhost:12")
  })

  test("skips the server we just failed against and dead ones", async () => {
    const records = [record(11, "/wanted", 1), record(12, "/wanted", 9)]
    const found = await findWorkspaceServer("/wanted", "http://localhost:12", deps(records, { 11: { ok: true } }))
    expect(found).toBe("http://localhost:11")
  })

  test("prefers a server that is not itself retiring", async () => {
    const records = [record(11, "/wanted", 1), record(12, "/wanted", 9)]
    const found = await findWorkspaceServer("/wanted", undefined, deps(records, {
      11: { ok: true },
      12: { ok: true, retiring: true },
    }))
    expect(found).toBe("http://localhost:11")
  })

  test("falls back to a retiring server rather than dropping the session", async () => {
    const records = [record(12, "/wanted", 9)]
    const found = await findWorkspaceServer("/wanted", undefined, deps(records, { 12: { ok: true, retiring: true } }))
    expect(found).toBe("http://localhost:12")
  })

  test("returns null when nothing is serving this workspace yet", async () => {
    const records = [record(11, "/wanted", 1), record(21, "/elsewhere", 9)]
    const found = await findWorkspaceServer("/wanted", undefined, deps(records, { 21: { ok: true } }))
    expect(found).toBeNull()
  })
})
