import { afterEach, expect, test } from "bun:test"
import { recolor } from "./components/ChunkyLogo.js"
import { incognitoSegment } from "./components/StatusLine.js"
import * as theme from "./theme.js"
import { compileTheme, DEFAULT_THEME } from "./themeCatalog.js"
import { getSyntaxStyle } from "./syntaxStyle.js"

// The accent swap is process-global, so every test puts it back.
afterEach(() => {
  theme.setIncognitoTheme(false)
  theme.setThemeAppearance("dark")
  theme.setColorTheme(DEFAULT_THEME)
})

test("custom colors update subscribers, survive incognito, and switch appearance", () => {
  const custom = compileTheme("custom", { theme: { primary: { dark: "#123456", light: "#654321" }, syntaxKeyword: "#abcdef" } })
  let updates = 0
  const unsubscribe = theme.subscribeTheme(() => updates++)
  theme.setColorTheme(custom)
  expect(theme.ACCENT).toBe("#123456")
  expect(theme.SYNTAX.KEYWORD).toBe("#abcdef")
  theme.setIncognitoTheme(true)
  expect(theme.ACCENT).toBe("#ff5f56")
  expect(theme.SYNTAX.KEYWORD).toBe("#abcdef")
  theme.setThemeAppearance("light")
  theme.setIncognitoTheme(false)
  expect(theme.ACCENT).toBe("#654321")
  expect(updates).toBe(4)
  unsubscribe()
})

test("punctuation and operators use independent custom colors in the native syntax style", () => {
  theme.setColorTheme(compileTheme("custom", { theme: { syntaxOperator: "#123456", syntaxPunctuation: "#abcdef" } }))
  expect(getSyntaxStyle().getStyle("operator")?.fg?.toInts().slice(0, 3)).toEqual([18, 52, 86])
  expect(getSyntaxStyle().getStyle("punctuation")?.fg?.toInts().slice(0, 3)).toEqual([171, 205, 239])
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
