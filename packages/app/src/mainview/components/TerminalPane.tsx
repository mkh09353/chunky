import { useEffect, useRef } from "react"
import {
  attachTerminal,
  detachTerminal,
  getEntry,
  resizeTerminal,
} from "../lib/terminalRuntime"

/**
 * The visible mount point for ONE terminal. Owns no terminal state itself: the
 * xterm instance and its <div> live in lib/terminalRuntime, so unmounting this
 * component (switching to the chat tab) parks the terminal offscreen instead of
 * destroying it. Re-mounting re-parents the same, still-scrolled-back div.
 *
 * Also the only place PTY resizes originate: a ResizeObserver debounces
 * `fit()`, and we tell bun only when the CELL grid actually changed — pixel
 * resizes that don't cross a character boundary are noise, and SIGWINCH storms
 * make full-screen TUIs (vim, htop) redraw constantly.
 */
export function TerminalPane({ terminalId }: { terminalId: string }) {
  const mountRef = useRef<HTMLDivElement>(null)
  // Last geometry reported to bun, so we can dedupe.
  const lastSize = useRef<{ cols: number; rows: number } | null>(null)

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return
    attachTerminal(terminalId, mount)

    let frame = 0
    let timer: ReturnType<typeof setTimeout> | undefined

    const fitNow = () => {
      const entry = getEntry(terminalId)
      if (!entry) return
      // A hidden/zero-size mount makes fit() compute NaN cells; skip until laid out.
      if (mount.clientWidth === 0 || mount.clientHeight === 0) return
      try {
        entry.fit.fit()
      } catch {
        return
      }
      const { cols, rows } = entry.term
      if (!cols || !rows) return
      const prev = lastSize.current
      if (prev && prev.cols === cols && prev.rows === rows) return
      lastSize.current = { cols, rows }
      resizeTerminal(terminalId, cols, rows)
    }

    const scheduleFit = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        // rAF so we measure after the browser has settled the new layout.
        frame = requestAnimationFrame(fitNow)
      }, 60)
    }

    // Becoming visible is itself a size change (the mount was 0×0 while hidden).
    scheduleFit()
    getEntry(terminalId)?.term.focus()

    const observer = new ResizeObserver(scheduleFit)
    observer.observe(mount)

    return () => {
      observer.disconnect()
      if (timer) clearTimeout(timer)
      if (frame) cancelAnimationFrame(frame)
      // Park it offscreen — alive, scrollback intact, process untouched.
      detachTerminal(terminalId)
    }
  }, [terminalId])

  return (
    <div
      className="chunky-term-pane"
      ref={mountRef}
      onClick={() => getEntry(terminalId)?.term.focus()}
    />
  )
}
