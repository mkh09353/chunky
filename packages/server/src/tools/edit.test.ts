import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { editTool } from "./edit.ts"
import { asToolRunResult } from "./result.ts"

function workspace() {
  return mkdtempSync(join(tmpdir(), "chunky-edit-result-"))
}

describe("edit dual output", () => {
  test("returns a short prompt and structured 1-based edit ranges", async () => {
    const root = workspace()
    writeFileSync(join(root, "sample.txt"), "one\ntwo\nthree\n", "utf8")

    const result = asToolRunResult(await editTool.invoke(
      { path: "sample.txt", edits: [{ oldText: "two\nthree", newText: "TWO\nTHREE" }] },
      { configurable: { workspace: root } },
    ))

    expect(result.promptText).toBe("Successfully replaced 1 block(s) in sample.txt.")
    expect(result.raw).toEqual({
      kind: "edit",
      path: "sample.txt",
      editCount: 1,
      edits: [{
        editIndex: 0,
        startLine: 2,
        endLine: 3,
        oldText: "two\nthree",
        newText: "TWO\nTHREE",
        fuzzy: false,
      }],
    })
    expect(readFileSync(join(root, "sample.txt"), "utf8")).toBe("one\nTWO\nTHREE\n")
  })

  test("bounds large edit snippets without changing prompt text", async () => {
    const root = workspace()
    const oldText = "x".repeat(2_500)
    const newText = "y".repeat(2_500)
    writeFileSync(join(root, "large.txt"), oldText, "utf8")

    const result = asToolRunResult(await editTool.invoke(
      { path: "large.txt", edits: [{ oldText, newText }] },
      { configurable: { workspace: root } },
    ))
    const raw = result.raw as any

    expect(result.promptText).toBe("Successfully replaced 1 block(s) in large.txt.")
    expect(raw.edits[0].oldText).toHaveLength(2_000)
    expect(raw.edits[0].newText).toHaveLength(2_000)
    expect(raw.edits[0].snippetsTruncated).toBe(true)
  })
})
