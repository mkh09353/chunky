import { afterEach, expect, test } from "bun:test"
import { recolor } from "./components/ChunkyLogo.js"
import { incognitoSegment } from "./components/StatusLine.js"
import * as theme from "./theme.js"

// The accent swap is process-global, so every test puts it back.
afterEach(() => {
  theme.setIncognitoTheme(false)
})

test("the default palette is the lavender brand accent", () => {
  expect(theme.ACCENT).toBe("#c4b1f9")
  expect(theme.HEADING).toBe("#c4b1f9")
  expect(theme.isIncognitoTheme()).toBe(false)
})

test("going incognito retints the whole accent family red", () => {
  expect(theme.setIncognitoTheme(true)).toBe(true)
  expect(theme.isIncognitoTheme()).toBe(true)
  for (const token of [theme.ACCENT, theme.ACCENT_DEEP, theme.HEADING, theme.MARKER_BULLET]) {
    // Red channel dominant = the lavender family (blue-dominant) is gone.
    const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(token.slice(i, i + 2), 16)) as [number, number, number]
    expect(r).toBeGreaterThan(b)
    expect(r).toBeGreaterThan(g)
  }
  expect(theme.ACCENT_DEEP).toBe("#ff3b30")
})

test("leaving incognito restores the lavender exactly", () => {
  theme.setIncognitoTheme(true)
  expect(theme.setIncognitoTheme(false)).toBe(true)
  expect(theme.ACCENT).toBe("#c4b1f9")
  expect(theme.ACCENT_DEEP).toBe("#a78bfa")
  expect(theme.HEADING).toBe("#c4b1f9")
  expect(theme.MARKER_BULLET).toBe("#766e91")
})

test("a repeated set is a no-op (nothing to rebuild)", () => {
  expect(theme.setIncognitoTheme(false)).toBe(false)
  theme.setIncognitoTheme(true)
  expect(theme.setIncognitoTheme(true)).toBe(false)
})

test("consumers see the swap through the live binding, not a stale copy", async () => {
  // StatusLine imported ACCENT at module load; the chip must still come back red.
  expect(incognitoSegment(false)).toBeNull()
  expect(incognitoSegment(true)?.color).toBe("#c4b1f9")
  theme.setIncognitoTheme(true)
  expect(incognitoSegment(true)).toEqual({ text: "INCOGNITO", color: "#ff5f56" })
})

test("the mascot's violet rotates onto the incognito red, and nothing else moves", () => {
  // Brand violet from the art → red-dominant, same lightness family.
  const red = recolor("#b688f4")!
  const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(red.slice(i, i + 2), 16)) as [number, number, number]
  expect(r).toBeGreaterThan(g)
  expect(r).toBeGreaterThan(b)
  // The laptop's grays and its blue-gray shadow are NOT the brand hue: untouched.
  expect(recolor("#2a323c")).toBe("#2a323c")
  expect(recolor("#cecfd3")).toBe("#cecfd3")
  expect(recolor(undefined)).toBeUndefined()
})
