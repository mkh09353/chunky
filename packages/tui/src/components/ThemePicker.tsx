import { ThemeText } from "./ThemeText.js"
import { useEffect, useRef, useState } from "react"
import { useTerminalDimensions } from "@opentui/react"
import { TextAttributes } from "@opentui/core"
import { useInput, usePasteText } from "../useInput.js"
import { loadThemeCatalog, saveThemePreference, themeDirectories } from "../themeCatalog.js"
import { ACCENT, BORDER, ERROR, PANEL, TEXT, WARNING, currentColorTheme, setColorTheme } from "../theme.js"

export function ThemePicker({ cwd, onClose, initialError = "" }: { cwd: string; onClose: () => void; initialError?: string }) {
  const [catalog] = useState(() => loadThemeCatalog(themeDirectories(cwd)))
  const initial = useRef(currentColorTheme())
  const confirmed = useRef(false)
  const [filter, setFilter] = useState("")
  const [selected, setSelected] = useState(() => Math.max(0, catalog.themes.findIndex((theme) => theme.id === initial.current.id)))
  const [error, setError] = useState(initialError)
  const { height } = useTerminalDimensions()
  const rows = catalog.themes.filter((theme) => theme.id.toLowerCase().includes(filter.toLowerCase()))
  const active = rows[selected]
  const visibleCount = Math.max(1, Math.min(7, height - 12))
  const start = Math.max(0, Math.min(selected - Math.floor(visibleCount / 2), rows.length - visibleCount))

  useEffect(() => {
    setColorTheme(active ?? initial.current)
  }, [active])
  useEffect(() => () => {
    if (!confirmed.current) setColorTheme(initial.current)
  }, [])

  function search(value: string) {
    setFilter(value.replace(/[\x00-\x1f\x7f]/g, ""))
    setSelected(0)
    setError("")
  }
  function accept() {
    if (!active) return
    try {
      saveThemePreference(active.id)
      setColorTheme(active)
      confirmed.current = true
      onClose()
    } catch (error) { setError(`Could not save: ${(error as Error).message}`) }
  }
  useInput((input, key) => {
    if (key.escape) { setColorTheme(initial.current); onClose(); return }
    if (key.return) { accept(); return }
    if (key.upArrow || key.downArrow) {
      setSelected((index) => rows.length ? (index + (key.upArrow ? -1 : 1) + rows.length) % rows.length : 0)
      return
    }
    if (key.backspace || key.delete) search(filter.slice(0, -1))
    else if (input && !key.ctrl && !key.meta) search(filter + input)
  })
  usePasteText((text) => search(filter + text))

  return (
    <box border borderStyle="rounded" borderColor={BORDER} backgroundColor={PANEL} flexDirection="column" paddingX={1} flexShrink={0}>
      <ThemeText fg={ACCENT} attributes={TextAttributes.BOLD}>Theme · live preview</ThemeText>
      <ThemeText fg={TEXT}>{`Search: ${filter || "type to filter"}`}</ThemeText>
      {rows.slice(start, start + visibleCount).map((theme, index) => (
        <ThemeText key={theme.id} fg={start + index === selected ? ACCENT : TEXT}
          onMouseDown={() => setSelected(start + index)}>
          {`${start + index === selected ? "❯" : " "} ${theme.id}${theme.id === initial.current.id ? " · current" : ""}${theme.source === "built-in" ? "" : " · custom"}`}
        </ThemeText>
      ))}
      {!rows.length && <ThemeText fg={WARNING}>No matching themes</ThemeText>}
      {rows.length > visibleCount && <ThemeText fg={BORDER}>{`${selected + 1} / ${rows.length}`}</ThemeText>}
      {catalog.errors.length > 0 && <ThemeText fg={WARNING}>{`${catalog.errors.length} theme file(s) skipped · ${catalog.errors[0]}`}</ThemeText>}
      {error && <ThemeText fg={ERROR}>{error}</ThemeText>}
      <ThemeText fg={BORDER}>↑↓ preview · enter save · esc cancel</ThemeText>
    </box>
  )
}
