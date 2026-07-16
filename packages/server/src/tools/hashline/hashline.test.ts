import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "bun:test"
import type { ToolRunResult } from "../result.ts"
import { applyHashline } from "./apply.ts"
import { formatAnchor, parseAnchor, splitLines } from "./scheme.ts"
import { hashlineEdit } from "./edit-hashline.ts"
import { hashlineRead } from "./read-hashline.ts"

const file = (content: string) => { const dir = mkdtempSync(join(tmpdir(), "hashline-")); const path = join(dir, "x.txt"); writeFileSync(path, content); return { dir, path } }
const anchor = (content: string, line: number) => formatAnchor(line, splitLines(content))

test("anchor parse/format strictness", () => {
  expect(parseAnchor("2:abc:def→value")).toEqual({ line: 2, local: "abc", chunk: "def" })
  expect(parseAnchor("2:abc:def->value").line).toBe(2)
  expect(() => parseAnchor("0:abc:def")).toThrow()
  expect(() => parseAnchor("2:ABC:def")).toThrow()
  expect(() => parseAnchor("2:abc")).toThrow()
})

test("trailing logical lines", () => expect(splitLines("a\n")).toEqual(["a", ""]))

test("overlapping_edits_error", () => {
  const content = "a\nb\nc\n"
  const result = applyHashline(content, [{ op: "replace", anchor: anchor(content, 1), end_anchor: anchor(content, 2), content: "x" }, { op: "replace", anchor: anchor(content, 2), content: "y" }])
  expect("error" in result && result.error!.kind).toBe("overlapping_edits")
})

test("shifted_recovery_after_insert_above", () => {
  const old = Array.from({ length: 16 }, (_, i) => `line-${i + 1}`).join("\n")
  const current = `${Array.from({ length: 8 }, (_, i) => `insert-${i + 1}`).join("\n")}\n${old}`
  const result = applyHashline(current, [{ op: "replace", anchor: anchor(old, 9), content: "REPLACED" }])
  expect(result).toHaveProperty("error.kind", "anchor_stale")
  expect(result).toHaveProperty("error.shiftedTo", 17)
  expect(result).toHaveProperty("error.shiftedAnchor", anchor(current, 17))
})

test("shifted_recovery_after_delete_above", () => {
  const old = Array.from({ length: 16 }, (_, i) => `line-${i + 1}`).join("\n")
  const current = old.split("\n").slice(8).join("\n")
  const result = applyHashline(current, [{ op: "replace", anchor: anchor(old, 9), content: "REPLACED" }])
  expect(result).toHaveProperty("error.kind", "anchor_stale")
  expect(result).toHaveProperty("error.shiftedTo", 1)
  expect(result).toHaveProperty("error.shiftedAnchor", anchor(current, 1))
})

test("shifted recovery tolerates changed chunk context after insertion", () => {
  const old = "alpha\ntarget = 1\nomega"
  const current = "new-one\nnew-two\nalpha\ntarget = 1\nomega"
  const result = applyHashline(current, [{ op: "replace", anchor: anchor(old, 2), content: "target = 2" }])
  expect(result).toHaveProperty("error.kind", "anchor_stale")
  expect(result).toHaveProperty("error.shiftedTo", 4)
  expect(result).toHaveProperty("error.shiftedAnchor", anchor(current, 4))
})

test("shifted recovery tolerates changed chunk context after deletion", () => {
  const old = "remove-me\nalpha\ntarget = 1\nomega"
  const current = "alpha\ntarget = 1\nomega"
  const result = applyHashline(current, [{ op: "replace", anchor: anchor(old, 3), content: "target = 2" }])
  expect(result).toHaveProperty("error.kind", "anchor_stale")
  expect(result).toHaveProperty("error.shiftedTo", 2)
  expect(result).toHaveProperty("error.shiftedAnchor", anchor(current, 2))
})

test("shifted_anchor_is_usable", () => {
  const old = Array.from({ length: 16 }, (_, i) => `line-${i + 1}`).join("\n")
  const current = `${Array.from({ length: 8 }, () => "insert").join("\n")}\n${old}`
  const stale = applyHashline(current, [{ op: "replace", anchor: anchor(old, 9), content: "B" }])
  expect(stale).toHaveProperty("error.shiftedAnchor")
  if (!("error" in stale) || !stale.error?.shiftedAnchor) throw new Error("expected shifted anchor")
  const retried = applyHashline(current, [{ op: "replace", anchor: stale.error.shiftedAnchor, content: "B" }])
  expect(retried).not.toHaveProperty("error")
  expect(retried.text).toContain("line-8\nB\nline-10")
})

test("atomic batch failure with unchanged file/content", () => {
  const content = "a\nb"; const result = applyHashline(content, [{ op: "replace", anchor: anchor(content, 1), content: "A" }, { op: "replace", anchor: "99:aaa:bbb", content: "X" }])
  expect(result).toHaveProperty("error"); expect(content).toBe("a\nb")
})

test("write success and write+other rejection", () => {
  expect(applyHashline("old", [{ op: "write", content: "new" }])).toHaveProperty("text", "new")
  expect(applyHashline("old", [{ op: "write", content: "new" }, { op: "insert_after", anchor: "0:", content: "x" }])).toHaveProperty("error.kind", "invalid_input")
})

test("anchor-prefix rejection including Unicode arrow and ASCII arrow", () => {
  const content = "a"
  for (const pasted of ["1:aaa:bbb→a", "1:aaa:bbb->a"]) expect(applyHashline(content, [{ op: "write", content: pasted }])).toHaveProperty("error")
})

test("same-position insertion ordering", () => {
  const result = applyHashline("a", [{ op: "insert_after", anchor: "0:", content: "first" }, { op: "insert_after", anchor: "0:", content: "second" }])
  expect(result.text).toBe("first\nsecond\na")
})

test("read→edit integration", async () => {
  const { dir, path } = file("hello\nworld")
  const output = await hashlineRead.invoke({ path }, { configurable: { workspace: dir } })
  const parsed = String(output).match(/^(\d+:[a-z]+:[a-z]+)→hello/m)!
  await hashlineEdit.invoke({ path, edits: [{ op: "replace", anchor: parsed[1], content: "hi" }] }, { configurable: { workspace: dir } })
  expect(readFileSync(path, "utf8")).toBe("hi\nworld")
})

test("structured ToolRunResult raw", async () => {
  const { dir, path } = file("a")
  const result = await hashlineEdit.invoke({ path, edits: [{ op: "write", content: "b" }] }, { configurable: { workspace: dir } }) as ToolRunResult
  expect(result).toHaveProperty("raw.kind", "hashline_edit")
  expect(result).toHaveProperty("raw.status", "ok")
})

test("replacement range warnings use documented boundaries", () => {
  const content = Array.from({ length: 25 }, (_, i) => `line-${i + 1}`).join("\n")
  const make = (count: number) => applyHashline(content, [{ op: "replace", anchor: anchor(content, 1), end_anchor: anchor(content, count), content: "x" }])
  expect(make(5).warnings!).toEqual([])
  expect(make(6).warnings![0]!).toContain("Medium")
  expect(make(20).warnings![0]!).toContain("Medium")
  expect(make(21).warnings![0]!).toContain("Large")
})

test("large write snippet is bounded", () => {
  const content = Array.from({ length: 100 }, (_, i) => `line-${i + 1}`).join("\n")
  const result = applyHashline("old", [{ op: "write", content }])
  expect(result.snippet!.split("\n").length).toBeLessThan(20)
})
