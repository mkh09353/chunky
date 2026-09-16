import { afterEach, expect, test } from "bun:test"
import { act, useState, useSyncExternalStore } from "react"
import { testRender } from "@opentui/react/test-utils"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ThemePicker } from "./ThemePicker.js"
import { ThemeText } from "./ThemeText.js"
import { ACCENT, BACKGROUND, currentColorTheme, setColorTheme, subscribeTheme, themeRevision } from "../theme.js"
import { DEFAULT_THEME, readThemePreference } from "../themeCatalog.js"
import { getSyntaxStyle } from "../syntaxStyle.js"

const oldSettings = process.env.CHUNKY_SETTINGS
const oldConfigHome = process.env.XDG_CONFIG_HOME
const roots: string[] = []
afterEach(() => {
  if (oldSettings === undefined) delete process.env.CHUNKY_SETTINGS
  else process.env.CHUNKY_SETTINGS = oldSettings
  if (oldConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = oldConfigHome
  setColorTheme(DEFAULT_THEME)
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
})

function Scene({ cwd }: { cwd: string }) {
  useSyncExternalStore(subscribeTheme, themeRevision)
  getSyntaxStyle()
  const [open, setOpen] = useState(true)
  return <box flexDirection="column" backgroundColor={BACKGROUND}>
    <ThemeText fg={ACCENT}>Accent sample</ThemeText>
    <ThemeText>Body sample</ThemeText>
    {open ? <ThemePicker cwd={cwd} onClose={() => setOpen(false)} /> : <ThemeText>Picker closed</ThemeText>}
  </box>
}

async function setup(width = 80, height = 30) {
  const root = mkdtempSync(join(tmpdir(), "chunky-theme-picker-"))
  roots.push(root)
  process.env.CHUNKY_SETTINGS = join(root, "settings.json")
  process.env.XDG_CONFIG_HOME = join(root, "config")
  const ui = await testRender(<Scene cwd={root} />, { width, height })
  await ui.waitForFrame((frame) => frame.includes("Theme · live preview"))
  return { ...ui, root }
}

test("arrow preview repaints the screen and syntax; Escape restores without saving", async () => {
  const ui = await setup()
  try {
    const before = ui.captureSpans()
    const keyword = getSyntaxStyle().getStyle("keyword")?.fg?.toString()
    await act(async () => { ui.mockInput.pressArrow("down") })
    await ui.waitFor(() => currentColorTheme().id === "tokyonight")
    await ui.flush()
    expect(ui.captureSpans()).not.toEqual(before)
    expect(getSyntaxStyle().getStyle("keyword")?.fg?.toString()).not.toBe(keyword)
    expect(readThemePreference(join(ui.root, "tui.json"))).toBe("chunky")
    await act(async () => { ui.mockInput.pressEscape(); await new Promise((resolve) => setTimeout(resolve, 40)) })
    await ui.waitForFrame((frame) => frame.includes("Picker closed"))
    expect(currentColorTheme().id).toBe("chunky")
    expect(ui.captureSpans().lines.slice(0, 2)).toEqual(before.lines.slice(0, 2))
    expect(() => readFileSync(join(ui.root, "tui.json"))).toThrow()
  } finally { await act(async () => { ui.renderer.destroy() }) }
})

test("failed persistence keeps the picker open and Escape still restores the original", async () => {
  const ui = await setup()
  try {
    writeFileSync(join(ui.root, "tui.json"), "{")
    await act(async () => { ui.mockInput.pressArrow("down") })
    await ui.waitFor(() => currentColorTheme().id === "tokyonight")
    await act(async () => { ui.mockInput.pressEnter() })
    await ui.waitForFrame((frame) => frame.includes("Could not save"))
    expect(readFileSync(join(ui.root, "tui.json"), "utf8")).toBe("{")
    await act(async () => { ui.mockInput.pressEscape(); await new Promise((resolve) => setTimeout(resolve, 40)) })
    await ui.waitForFrame((frame) => frame.includes("Picker closed"))
    expect(currentColorTheme().id).toBe("chunky")
  } finally { await act(async () => { ui.renderer.destroy() }) }
})

test("search then Enter saves the preview and does not roll back on unmount", async () => {
  const ui = await setup(44, 20)
  try {
    await act(async () => { await ui.mockInput.typeText("nord") })
    await ui.waitFor(() => currentColorTheme().id === "nord")
    await act(async () => { ui.mockInput.pressEnter() })
    await ui.waitForFrame((frame) => frame.includes("Picker closed"))
    expect(readThemePreference(join(ui.root, "tui.json"))).toBe("nord")
    expect(currentColorTheme().id).toBe("nord")
  } finally { await act(async () => { ui.renderer.destroy() }) }
})

test("empty search results restore the original preview and Enter does nothing", async () => {
  const ui = await setup()
  try {
    await act(async () => { ui.mockInput.pressArrow("down") })
    await ui.waitFor(() => currentColorTheme().id === "tokyonight")
    await act(async () => { await ui.mockInput.typeText("missing-theme") })
    await ui.waitForFrame((frame) => frame.includes("No matching themes"))
    await act(async () => { ui.mockInput.pressEnter() })
    await ui.flush()
    expect(currentColorTheme().id).toBe("chunky")
    expect(ui.captureCharFrame()).toContain("esc cancel")
  } finally { await act(async () => { ui.renderer.destroy() }) }
})
