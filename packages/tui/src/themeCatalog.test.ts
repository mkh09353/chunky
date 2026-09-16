import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { compileTheme, loadThemeCatalog, readThemePreference, saveThemePreference } from "./themeCatalog.js"

const temporary: string[] = []
function directory() {
  const path = mkdtempSync(join(tmpdir(), "chunky-theme-test-"))
  temporary.push(path)
  return path
}
afterEach(() => temporary.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })))

test("custom themes resolve shared colors and light/dark variants", () => {
  const theme = compileTheme("custom", { defs: { violet: "#abc" }, theme: {
    primary: { dark: "violet", light: "#123456" }, markdownHeading: "primary", background: "none",
  } })
  expect(theme.dark.primary).toBe("#aabbcc")
  expect(theme.light.markdownHeading).toBe("#123456")
  expect(theme.dark.background).toBe("none")
})

test("invalid colors, broken references and cycles reject the whole theme", () => {
  for (const theme of [
    { primary: "not-a-color" },
    { primary: "secondary", secondary: "primary" },
    { primary: { dark: "#123456" } },
    { primary: 256 },
  ]) expect(() => compileTheme("broken", { theme })).toThrow()
})

test("a definition may share a token name without being a circular reference", () => {
  expect(compileTheme("custom", { defs: { primary: "#123456" }, theme: { primary: "primary" } }).dark.primary).toBe("#123456")
})

test("project themes override user themes; a malformed override preserves the valid theme", () => {
  const user = directory(), project = directory()
  writeFileSync(join(user, "custom.json"), JSON.stringify({ theme: { primary: "#112233" } }))
  writeFileSync(join(project, "custom.json"), JSON.stringify({ theme: { primary: "#445566" } }))
  writeFileSync(join(project, "broken.json"), "{")
  let catalog = loadThemeCatalog([user, project])
  expect(catalog.themes.find((theme) => theme.id === "custom")?.dark.primary).toBe("#445566")
  expect(catalog.errors).toHaveLength(1)
  writeFileSync(join(project, "custom.json"), "{")
  catalog = loadThemeCatalog([user, project])
  expect(catalog.themes.find((theme) => theme.id === "custom")?.dark.primary).toBe("#112233")
})

test("selection survives restart and failed writes throw instead of claiming success", () => {
  const root = directory(), config = join(root, "nested", "tui.json")
  expect(readThemePreference(config)).toBe("chunky")
  saveThemePreference("nord", config)
  expect(readThemePreference(config)).toBe("nord")
  mkdirSync(join(root, "blocked"))
  expect(() => saveThemePreference("dracula", join(root, "blocked"))).toThrow()
})
