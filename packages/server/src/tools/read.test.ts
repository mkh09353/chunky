import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { read } from "./read.ts"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function invoke(name: string, content: string | Buffer, args: { offset?: number; limit?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "chunky-read-"))
  roots.push(root)
  writeFileSync(join(root, name), content)
  return read.invoke({ path: name, ...args }, { configurable: { workspace: root } })
}

function invokePath(root: string, path: string) {
  return read.invoke({ path }, { configurable: { workspace: root } })
}

describe("read output bounds", () => {
  test("returns a clamped first line and sane footer for a single huge line", async () => {
    const output = String(await invoke("huge.txt", "a".repeat(50_000)))

    expect(output).toStartWith("a".repeat(2_000))
    expect(output).toContain("… [line truncated, 50000 chars total]")
    // The whole (clamped) file was shown, so no "continue" footer pointing past EOF.
    expect(output).not.toContain("Use offset=")
    expect(output).not.toContain("lines 1-0")
  })

  test("clamps a long line in the middle of a file", async () => {
    const output = String(await invoke("middle.txt", `first\n${"b".repeat(3_000)}\nlast`))

    expect(output).toContain(`first\n${"b".repeat(2_000)}… [line truncated, 3000 chars total]\nlast`)
  })
})

describe("read binary detection", () => {
  test("returns a notice for PNG magic bytes", async () => {
    const output = String(await invoke("pixel.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1])))
    expect(output).toBe("[Binary file (image/png, 10 B) — not shown]")
  })

  test("returns a notice for an unknown file containing NUL bytes", async () => {
    const output = String(await invoke("unknown.bin", Buffer.from([0x61, 0x62, 0, 0x63])))
    expect(output).toBe("[Binary file (application/octet-stream, 4 B) — not shown]")
  })

  test("keeps SVG as text", async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><text>hello</text></svg>`
    expect(String(await invoke("image.svg", svg))).toBe(svg)
  })
})

test("past-EOF offsets return information instead of throwing", async () => {
  const output = await invoke("short.txt", "one\ntwo\nthree", { offset: 5_000 })
  expect(String(output)).toBe("[offset 5000 is past end of file — file has 3 lines]")
})

describe("read path hardening", () => {
  test("refuses a FIFO without hanging", async () => {
    const root = mkdtempSync(join(tmpdir(), "chunky-read-"))
    roots.push(root)
    execFileSync("mkfifo", [join(root, "pipe")])

    expect(String(await invokePath(root, "pipe"))).toBe("[Not a regular file (fifo) — refused]")
  }, 1_000)

  test("returns a sane notice for a directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "chunky-read-"))
    roots.push(root)
    mkdirSync(join(root, "folder"))

    expect(String(await invokePath(root, "folder"))).toBe("[Not a regular file (directory) — refused]")
  })

  test("repairs normalization, narrow spaces, and curly quotes in combination", async () => {
    const root = mkdtempSync(join(tmpdir(), "chunky-read-"))
    roots.push(root)
    const actual = "Cafe\u0301\u202fDon’t.txt"
    writeFileSync(join(root, actual), "repaired")

    expect(String(await invokePath(root, "Café Don't.txt"))).toBe("repaired")
  })

  test("rejects a traversal before attempting repairs", async () => {
    const root = mkdtempSync(join(tmpdir(), "chunky-read-"))
    roots.push(root)

    expect(invokePath(root, "../outside’s.txt")).rejects.toThrow("path escapes the workspace")
  })

  test("suggests a close filename", async () => {
    const root = mkdtempSync(join(tmpdir(), "chunky-read-"))
    roots.push(root)
    writeFileSync(join(root, "AGENTS.md"), "agents")

    expect(invokePath(root, "AGENT.md")).rejects.toThrow("file not found: AGENT.md. Did you mean AGENTS.md?")
  })

  test("uses a plain not-found error when there are no suggestions", async () => {
    const root = mkdtempSync(join(tmpdir(), "chunky-read-"))
    roots.push(root)
    writeFileSync(join(root, "unrelated.txt"), "nope")

    expect(invokePath(root, "missing.md")).rejects.toThrow("file not found: missing.md")
  })
})
