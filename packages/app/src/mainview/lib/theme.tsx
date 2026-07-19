// Theme mode: system / light / dark, persisted per client.
//
// WHY WE RESOLVE "system" OURSELVES RATHER THAN HANDING IT TO <Theme mode="system">
// ---------------------------------------------------------------------------------
// Astryx's own `mode="system"` REMOVES `data-theme` from <html>, which leaves the
// document at `color-scheme: light dark`. Every Astryx color token is a
// `light-dark(<light>, <dark>)` pair, so the branch a node paints depends on its
// COMPUTED color-scheme — and WKWebView (electrobun's engine) is stricter than
// Chromium about inheriting color-scheme into contenteditable subtrees. A node
// that slips out of that context paints the wrong branch: historically the chat
// composer rendered typed text as near-invisible specks ("dots") whenever the OS
// was in Light Mode. The app worked around this by hard-coding dark everywhere.
//
// So: we keep the forced-color-scheme trick, but make it FOLLOW the resolved theme
// instead of pinning it to dark. `system` is resolved to a concrete "light" | "dark"
// here (via matchMedia), and only that concrete value is ever written to
// `data-theme` / `color-scheme` / <Theme mode>. `color-scheme` is therefore always
// a single unambiguous keyword — never the `light dark` pair — in BOTH modes, which
// is what keeps light-dark() deterministic and the composer legible.
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react"

/** What the user picked. */
export type ThemeMode = "system" | "light" | "dark"
/** What we actually paint — `system` collapsed against the OS preference. */
export type ResolvedTheme = "light" | "dark"

/** localStorage key. Mirrored by the pre-paint bootstrap in index.html — change
 *  both together, or the first frame disagrees with React and the theme flashes. */
export const THEME_STORAGE_KEY = "chunky.theme"

/** Cycle order for the toggle button and bare `/theme`. */
export const THEME_MODES: readonly ThemeMode[] = ["system", "light", "dark"]

const DARK_QUERY = "(prefers-color-scheme: dark)"

export function isThemeMode(value: unknown): value is ThemeMode {
  return value === "system" || value === "light" || value === "dark"
}

/** The stored preference, or "system" when unset/corrupt. */
export function loadThemeMode(): ThemeMode {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY)
    return isThemeMode(raw) ? raw : "system"
  } catch {
    // Private-mode / disabled storage: fall back rather than failing to boot.
    return "system"
  }
}

function saveThemeMode(mode: ThemeMode): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, mode)
  } catch {
    /* non-fatal: the session still themes correctly, it just won't persist */
  }
}

/** The OS preference right now. */
export function systemTheme(): ResolvedTheme {
  return typeof matchMedia === "function" && matchMedia(DARK_QUERY).matches ? "dark" : "light"
}

export function resolveTheme(mode: ThemeMode): ResolvedTheme {
  return mode === "system" ? systemTheme() : mode
}

/**
 * Write the resolved mode to <html>. Sets BOTH:
 *  - `data-theme` — what Astryx's reset.css and our own `[data-theme=…]` overrides key off.
 *  - inline `color-scheme` — the forced, single-keyword value that makes light-dark()
 *    resolve deterministically even in WebKit's contenteditable subtrees (see the
 *    module header). Inline so it beats any stylesheet that would relax it to `light dark`.
 *
 * Kept in sync with the pre-paint bootstrap in index.html.
 */
export function applyResolvedTheme(resolved: ResolvedTheme): void {
  const root = document.documentElement
  root.setAttribute("data-theme", resolved)
  root.style.colorScheme = resolved
}

/** Subscribe to OS light/dark changes. Returns an unsubscribe. */
export function watchSystemTheme(onChange: (resolved: ResolvedTheme) => void): () => void {
  if (typeof matchMedia !== "function") return () => {}
  const mq = matchMedia(DARK_QUERY)
  const handler = (e: MediaQueryListEvent) => onChange(e.matches ? "dark" : "light")
  mq.addEventListener("change", handler)
  return () => mq.removeEventListener("change", handler)
}

export interface ThemeController {
  /** The user's setting (may be "system"). */
  mode: ThemeMode
  /** What's actually painted. */
  resolved: ResolvedTheme
  setMode: (mode: ThemeMode) => void
  /** Advance system → light → dark → system. */
  cycleMode: () => ThemeMode
}

const ThemeModeContext = createContext<ThemeController | null>(null)

/**
 * Owns the theme preference and keeps <html> in sync. Must sit ABOVE Astryx's
 * <Theme>, which is handed the already-resolved concrete mode.
 */
export function ThemeModeProvider({ children }: { children: (resolved: ResolvedTheme) => React.ReactNode }) {
  // Initialised from storage during the first render, so we agree with the
  // pre-paint bootstrap and never flash a different theme on startup.
  const [mode, setModeState] = useState<ThemeMode>(loadThemeMode)
  const [system, setSystem] = useState<ResolvedTheme>(systemTheme)

  // Only meaningful while mode === "system", but the listener is cheap and always
  // attached so switching back to "system" is immediately correct.
  useEffect(() => watchSystemTheme(setSystem), [])

  const resolved: ResolvedTheme = mode === "system" ? system : mode

  // Re-assert on every change. Layout effect isn't needed: the bootstrap already
  // painted the right theme, and later changes are user-initiated.
  useEffect(() => {
    applyResolvedTheme(resolved)
  }, [resolved])

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next)
    saveThemeMode(next)
  }, [])

  // Derived from `mode` rather than a state updater: the updater would have to
  // persist as a side effect, and StrictMode runs updaters twice.
  const cycleMode = useCallback(() => {
    const i = THEME_MODES.indexOf(mode)
    const next = THEME_MODES[(i + 1) % THEME_MODES.length]!
    setMode(next)
    return next
  }, [mode, setMode])

  const value = useMemo<ThemeController>(
    () => ({ mode, resolved, setMode, cycleMode }),
    [mode, resolved, setMode, cycleMode],
  )

  return <ThemeModeContext.Provider value={value}>{children(resolved)}</ThemeModeContext.Provider>
}

export function useThemeMode(): ThemeController {
  const ctx = useContext(ThemeModeContext)
  if (!ctx) throw new Error("useThemeMode must be used inside <ThemeModeProvider>")
  return ctx
}
