import { ComputerDesktopIcon, MoonIcon, SunIcon } from "@heroicons/react/24/outline"
import { useThemeMode, type ThemeMode } from "../lib/theme"

/** Icon + wording per setting. `system` shows a monitor regardless of which way it
 *  currently resolves — the button reports the SETTING, not the paint. */
const FACES: Record<ThemeMode, { Icon: typeof SunIcon; label: string }> = {
  system: { Icon: ComputerDesktopIcon, label: "Match system" },
  light: { Icon: SunIcon, label: "Light" },
  dark: { Icon: MoonIcon, label: "Dark" },
}

/** Where the next click lands, so the tooltip can promise it. */
const NEXT: Record<ThemeMode, ThemeMode> = { system: "light", light: "dark", dark: "system" }

/**
 * Appearance toggle for the TopNav's end slot. One button cycling
 * system → light → dark, mirroring the bare `/theme` command so the two
 * affordances can't disagree.
 */
export function ThemeToggle() {
  const { mode, resolved, cycleMode } = useThemeMode()
  const { Icon, label } = FACES[mode]
  // "Match system" alone doesn't say what you're looking at — name the resolution too.
  const current = mode === "system" ? `${label} (${resolved})` : label

  return (
    <button
      type="button"
      className="chunky-theme-toggle"
      onClick={() => cycleMode()}
      title={`Appearance: ${current} — click for ${FACES[NEXT[mode]].label.toLowerCase()}`}
      aria-label={`Appearance: ${current}. Switch to ${FACES[NEXT[mode]].label.toLowerCase()}.`}
    >
      <Icon className="chunky-theme-toggle-icon" aria-hidden="true" />
    </button>
  )
}
