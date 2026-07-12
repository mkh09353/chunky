import { expect, test } from "bun:test"
import { ago, windowStart, RESUME_WINDOW } from "./ResumePicker.js"

const MIN = 60_000

test("ago buckets: just now, then minutes, hours, days", () => {
  const now = 1_000_000_000_000
  expect(ago(now - 20_000, now)).toBe("just now")
  expect(ago(now - 5 * MIN, now)).toBe("5m ago")
  expect(ago(now - 3 * 60 * MIN, now)).toBe("3h ago")
  expect(ago(now - 2 * 24 * 60 * MIN, now)).toBe("2d ago")
})

test("short lists never scroll; the window starts at 0", () => {
  expect(windowStart(0, 3)).toBe(0)
  expect(windowStart(2, 3)).toBe(0)
  expect(windowStart(RESUME_WINDOW - 1, RESUME_WINDOW)).toBe(0)
})

test("long lists keep the selection mid-window and clamp at both ends", () => {
  expect(windowStart(0, 100)).toBe(0) // top: no negative start
  expect(windowStart(50, 100)).toBe(50 - (RESUME_WINDOW >> 1)) // middle: centered
  expect(windowStart(99, 100)).toBe(100 - RESUME_WINDOW) // bottom: window stays full
})
