// Built-in browser pane: URL normalisation, persisted pane state, and the React
// context that lets deep components (TranscriptView's rendered markdown links)
// push a URL into the pane without threading another prop through ChatPane.
//
// The pane itself (components/BrowserPane.tsx) owns the <electrobun-webview>
// element; this module owns everything that isn't presentation.
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react"
import type { ReactNode } from "react"

/** localStorage keys — namespaced like `chunky.activeRepoId` / `chunky.theme`. */
const OPEN_KEY = "chunky.browser.open"
const WIDTH_KEY = "chunky.browser.width"
const URL_KEY = "chunky.browser.url"

/** Where the pane lands when it's opened with no remembered URL. */
export const BROWSER_HOME = "https://www.google.com"

/** Minimum width, in px, of EITHER pane. The divider clamps to this. */
export const MIN_PANE_PX = 360

/** Fallback width for the browser pane the first time it's opened (~45% of a
 *  default 1280px window, per the design brief). */
const DEFAULT_WIDTH_PX = 560

/**
 * True when `value` is a URL the webview is allowed to load. This is the single
 * security boundary for the pane: http/https only, nothing else — no file:,
 * about:, javascript:, data:, or custom app schemes.
 */
export function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value)
    return u.protocol === "http:" || u.protocol === "https:"
  } catch {
    return false
  }
}

// Bare hosts that legitimately carry no dot. The general "no dot ⇒ search" rule
// below would turn `localhost:4620` into a Google query, which is exactly the
// URL a developer running the harness is most likely to type into this pane.
const BARE_HOST_RE = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|\?|#|$)/i

/**
 * Turn whatever the user typed in the URL bar into a loadable http(s) URL, or
 * null when it can't be one.
 *
 * - an explicit scheme is honoured, but ONLY if it's http/https (else null)
 * - something host-shaped (has a dot, or is localhost) gets `https://` prepended
 * - anything else is treated as a search query
 */
export function normalizeUrl(input: string): string | null {
  const raw = input.trim()
  if (!raw) return null

  // Explicit scheme — accept http(s), reject everything else outright rather
  // than silently rewriting it into a search (a `file:///etc/passwd` typed by a
  // malicious link shouldn't become a Google query for the same string either,
  // but it must certainly never reach the webview).
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
    return isHttpUrl(raw) ? raw : null
  }

  const hostShaped = !/\s/.test(raw) && (raw.includes(".") || BARE_HOST_RE.test(raw))
  if (!hostShaped) {
    return `https://www.google.com/search?q=${encodeURIComponent(raw)}`
  }

  const withScheme = `https://${raw}`
  // A host-shaped string can still fail to parse ("https://:::"), in which case
  // fall back to searching for it rather than handing the webview a bad URL.
  return isHttpUrl(withScheme)
    ? withScheme
    : `https://www.google.com/search?q=${encodeURIComponent(raw)}`
}

/**
 * A navigation request. `seq` makes each request distinct so that clicking the
 * SAME link twice — after browsing elsewhere inside the pane — still navigates;
 * comparing URL strings alone would swallow the second click.
 */
export interface BrowserRequest {
  url: string
  seq: number
}

export interface BrowserPaneState {
  open: boolean
  request: BrowserRequest | null
  width: number
  openInBrowser: (url: string) => void
  toggle: () => void
  close: () => void
  setWidth: (px: number) => void
  /** Called by the pane when the webview navigates itself, so the remembered
   *  URL survives a relaunch. Does NOT trigger a navigation. */
  rememberUrl: (url: string) => void
}

function readStored<T>(key: string, parse: (raw: string) => T | null, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (raw == null) return fallback
    return parse(raw) ?? fallback
  } catch {
    // Private-mode / disabled storage: fall back rather than break the app.
    return fallback
  }
}

function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* storage unavailable — pane still works, just won't be remembered */
  }
}

/**
 * All browser-pane state, kept in one hook so App.tsx only gains a single line.
 * Open/closed, width and last URL are persisted to localStorage.
 */
export function useBrowserPane(): BrowserPaneState {
  const [open, setOpen] = useState(() => readStored(OPEN_KEY, (r) => r === "1", false))
  const [width, setWidthState] = useState(() =>
    readStored(
      WIDTH_KEY,
      (r) => {
        const n = Number.parseInt(r, 10)
        return Number.isFinite(n) && n >= MIN_PANE_PX ? n : null
      },
      DEFAULT_WIDTH_PX,
    ),
  )
  // Seeded from the remembered URL so re-opening the pane returns to where you
  // left off. seq 0 is the "restored" request — the pane treats it as its
  // initial `src` rather than a live navigation.
  const [request, setRequest] = useState<BrowserRequest | null>(() => {
    const remembered = readStored(URL_KEY, (r) => (isHttpUrl(r) ? r : null), "")
    return remembered ? { url: remembered, seq: 0 } : null
  })

  useEffect(() => writeStored(OPEN_KEY, open ? "1" : "0"), [open])
  useEffect(() => writeStored(WIDTH_KEY, String(width)), [width])

  const rememberUrl = useCallback((url: string) => {
    if (isHttpUrl(url)) writeStored(URL_KEY, url)
  }, [])

  const openInBrowser = useCallback((raw: string) => {
    const next = normalizeUrl(raw)
    // Silently ignore anything that can't become an http(s) URL — a mailto: or
    // file: link in a transcript should fall through to doing nothing here
    // rather than opening a blank pane.
    if (!next) return
    setRequest((prev) => ({ url: next, seq: (prev?.seq ?? 0) + 1 }))
    setOpen(true)
    writeStored(URL_KEY, next)
  }, [])

  const toggle = useCallback(() => {
    setOpen((wasOpen) => {
      // Opening with nothing remembered lands on the home page.
      if (!wasOpen) setRequest((prev) => prev ?? { url: BROWSER_HOME, seq: 0 })
      return !wasOpen
    })
  }, [])

  const close = useCallback(() => setOpen(false), [])

  const setWidth = useCallback((px: number) => setWidthState(px), [])

  return useMemo(
    () => ({ open, request, width, openInBrowser, toggle, close, setWidth, rememberUrl }),
    [open, request, width, openInBrowser, toggle, close, setWidth, rememberUrl],
  )
}

// ---- Context -------------------------------------------------------------
//
// Only `openInBrowser` is shared downward: TranscriptView needs to route a link
// into the pane, but nothing deep in the tree should be able to resize or close
// it. A no-op default keeps the component usable outside a provider (tests).

const BrowserContext = createContext<(url: string) => void>(() => {})

export function BrowserProvider({
  openInBrowser,
  children,
}: {
  openInBrowser: (url: string) => void
  children: ReactNode
}) {
  return <BrowserContext.Provider value={openInBrowser}>{children}</BrowserContext.Provider>
}

/** Open a URL in the built-in browser pane. */
export function useOpenInBrowser(): (url: string) => void {
  return useContext(BrowserContext)
}
