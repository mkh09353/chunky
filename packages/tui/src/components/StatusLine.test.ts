import { expect, test } from "bun:test"
import { formatWatching } from "./StatusLine.js"

test("nothing running hides the line entirely", () => {
  expect(formatWatching(0, 0)).toBeNull()
})

test("a zero count drops its whole segment", () => {
  expect(formatWatching(2, 0)).toBe("◎ watching · 2 tasks")
  expect(formatWatching(0, 3)).toBe("◎ watching · 3 monitors")
})

test("both counts render as separate dot-joined segments, tasks first", () => {
  expect(formatWatching(2, 3)).toBe("◎ watching · 2 tasks · 3 monitors")
})

test("counts of one are singular", () => {
  expect(formatWatching(1, 0)).toBe("◎ watching · 1 task")
  expect(formatWatching(0, 1)).toBe("◎ watching · 1 monitor")
  expect(formatWatching(1, 1)).toBe("◎ watching · 1 task · 1 monitor")
})

test("plural kicks in from two upward", () => {
  expect(formatWatching(2, 2)).toBe("◎ watching · 2 tasks · 2 monitors")
  expect(formatWatching(11, 40)).toBe("◎ watching · 11 tasks · 40 monitors")
})
