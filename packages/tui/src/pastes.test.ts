import { expect, test } from "bun:test"
import {
  expandPastes,
  normalizePaste,
  pasteLabel,
  shouldCollapsePaste,
} from "./pastes.js"

test("CR and CRLF newlines are normalized to LF so they can't overwrite lines", () => {
  expect(normalizePaste("a\r\nb\rc")).toBe("a\nb\nc")
  expect(normalizePaste("single line")).toBe("single line")
})

test("short single-line pastes stay inline; big/multi-line ones collapse", () => {
  expect(shouldCollapsePaste("just a path/to/file.ts")).toBe(false)
  expect(shouldCollapsePaste("a\nb\nc")).toBe(false) // 3 lines, under threshold
  expect(shouldCollapsePaste("a\nb\nc\nd\ne")).toBe(true) // 5 lines
  expect(shouldCollapsePaste("x".repeat(401))).toBe(true) // long single line
})

test("chip reads +lines for multi-line and +characters for one long line", () => {
  expect(pasteLabel(1, "a\nb\nc\nd\ne")).toBe("[Pasted text #1 +5 lines]")
  expect(pasteLabel(2, "x".repeat(500))).toBe("[Pasted text #2 +500 characters]")
})

test("the model gets the FULL text back — the chip is only for display", () => {
  const pastes = new Map<string, string>()
  const body = Array.from({ length: 42 }, (_, i) => `line ${i}`).join("\n")
  const chip = pasteLabel(1, body)
  pastes.set(chip, body)

  const display = `Please review ${chip} and fix it`
  const expanded = expandPastes(display, pastes)

  expect(display).toContain("+42 lines") // what the user/transcript sees
  expect(expanded).toBe(`Please review ${body} and fix it`) // what the model sees
  expect(expanded).toContain("line 41") // nothing was truncated
})

test("multiple pastes in one message each expand independently", () => {
  const pastes = new Map<string, string>()
  const a = pasteLabel(1, "AAA".repeat(200))
  const b = pasteLabel(2, "b\n".repeat(10))
  pastes.set(a, "AAA".repeat(200))
  pastes.set(b, "b\n".repeat(10))

  const expanded = expandPastes(`first ${a} then ${b}`, pastes)
  expect(expanded).toBe(`first ${"AAA".repeat(200)} then ${"b\n".repeat(10)}`)
})

test("a chip with no stored body (partially deleted) is left untouched", () => {
  const expanded = expandPastes("stray [Pasted text #9 +3 lines] token", new Map())
  expect(expanded).toBe("stray [Pasted text #9 +3 lines] token")
})
