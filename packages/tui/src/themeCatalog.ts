import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import tokyoNight from "./themes/tokyonight.json"
import catppuccin from "./themes/catppuccin.json"
import nord from "./themes/nord.json"
import gruvbox from "./themes/gruvbox.json"
import dracula from "./themes/dracula.json"

export const COLOR_KEYS = [
  "primary", "secondary", "accent", "text", "textMuted", "background", "backgroundPanel",
  "border", "success", "error", "warning", "markdownHeading", "markdownLink", "markdownCode",
  "markdownListItem", "syntaxComment", "syntaxKeyword", "syntaxString", "syntaxNumber",
  "syntaxFunction", "syntaxType", "syntaxVariable", "syntaxOperator", "syntaxPunctuation",
] as const
export type ThemeColor = typeof COLOR_KEYS[number]
export type ThemeColors = Partial<Record<ThemeColor, string>>
export interface ColorTheme {
  id: string
  source: string
  dark: ThemeColors
  light: ThemeColors
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

// Custom files use OpenCode's defs/theme structure. Only the tokens used by
// Chunky are resolved; extra tokens (e.g. diff backgrounds) are harmless.
export function compileTheme(id: string, input: unknown, source = "custom"): ColorTheme {
  if (!object(input) || !object(input.theme)) throw new Error("Expected a theme object")
  if (input.defs !== undefined && !object(input.defs)) throw new Error("Expected a defs object")
  const colors = input.theme
  const definitions = object(input.defs) ? input.defs : {}
  const variants = (mode: "dark" | "light"): ThemeColors => {
    function resolve(value: unknown, visited: Set<string>): string {
      if (object(value)) return resolve(value[mode], visited)
      if (typeof value !== "string") throw new Error(`Missing or invalid ${mode} color`)
      if (value === "none") return value
      if (/^#[\da-f]{6}$/i.test(value)) return value.toLowerCase()
      if (/^#[\da-f]{3}$/i.test(value)) return "#" + [...value.slice(1)].map((c) => c + c).join("").toLowerCase()
      const definition = Object.hasOwn(definitions, value)
      const reference = `${definition ? "defs" : "theme"}:${value}`
      if (visited.has(reference)) throw new Error(`Circular color reference: ${value}`)
      const next = definition ? definitions[value] : Object.hasOwn(colors, value) ? colors[value] : undefined
      if (next === undefined) throw new Error(`Unknown color: ${value}`)
      return resolve(next, new Set([...visited, reference]))
    }
    const result: ThemeColors = {}
    for (const key of COLOR_KEYS) {
      if (colors[key] !== undefined) result[key] = resolve(colors[key], new Set([`theme:${key}`]))
    }
    if (Object.keys(result).length === 0) throw new Error("No supported theme colors found")
    return result
  }
  return { id, source, dark: variants("dark"), light: variants("light") }
}

export const DEFAULT_THEME: ColorTheme = { id: "chunky", source: "built-in", dark: {}, light: {} }
const BUILTINS = [DEFAULT_THEME, ...Object.entries({ tokyonight: tokyoNight, catppuccin, nord, gruvbox, dracula })
  .map(([id, data]) => compileTheme(id, data, "built-in"))]

export function themeDirectories(cwd = process.cwd()): string[] {
  return [join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "chunky", "themes"), join(cwd, ".chunky", "themes")]
}

export function loadThemeCatalog(directories = themeDirectories()): { themes: ColorTheme[]; errors: string[] } {
  const themes = new Map(BUILTINS.map((theme) => [theme.id, theme]))
  const errors: string[] = []
  for (const directory of directories) {
    let files: string[]
    try { files = readdirSync(directory).filter((file) => file.endsWith(".json")).sort() }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") errors.push(`${directory}: ${(error as Error).message}`)
      continue
    }
    for (const file of files) {
      const id = file.slice(0, -5)
      try {
        if (id === "chunky") throw new Error("The chunky default theme is reserved; choose another filename")
        themes.set(id, compileTheme(id, JSON.parse(readFileSync(join(directory, file), "utf8")), join(directory, file)))
      } catch (error) { errors.push(`${file}: ${(error as Error).message}`) }
    }
  }
  return { themes: [...themes.values()], errors }
}

export function themePreferencePath(): string {
  const state = process.env.CHUNKY_SETTINGS ? dirname(process.env.CHUNKY_SETTINGS) : process.env.CHUNKY_HOME || join(homedir(), ".chunky", "state")
  return join(state, "tui.json")
}

export function readThemePreference(path = themePreferencePath()): string {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"))
    return typeof value?.theme === "string" ? value.theme : "chunky"
  } catch { return "chunky" }
}

// Kept separate from server settings: preview is process-local; confirmation
// persists only presentation preferences and reports write failures to the UI.
export function saveThemePreference(theme: string, path = themePreferencePath()): void {
  let previous: Record<string, unknown> = {}
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"))
    if (!object(value)) throw new Error("Expected an object in tui.json")
    previous = value
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify({ ...previous, theme }, null, 2) + "\n", { mode: 0o600 })
    renameSync(temporary, path)
  } finally { rmSync(temporary, { force: true }) }
}
