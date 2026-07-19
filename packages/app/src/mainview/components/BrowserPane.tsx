// The built-in browser pane — a real OS-level webview docked to the right of
// the chat, on Electrobun's <electrobun-webview> custom element.
//
// Three things about that element drive the shape of this file, all verified
// against electrobun@1.18.1's shipped preload
// (dist/api/bun/preload/webviewTag.ts):
//
//  1. The element is created IMPERATIVELY, not as JSX. Its `partition`,
//     `renderer`, `sandbox` and `masks` attributes are read exactly once, inside
//     connectedCallback → initWebview(), so they must already be set when the
//     node is appended. React sets some props after mount, which would be too
//     late; it may also move/recreate nodes on re-render, and a detach fires
//     disconnectedCallback → the native webview is destroyed. Owning the node
//     ourselves keeps its lifetime explicit.
//
//  2. Every method (loadURL, goBack, setNavigationRules, toggleHidden, …) is a
//     no-op while `webviewId === null`, and that id only arrives after an async
//     round-trip to bun. So anything we call right after mounting must wait —
//     see whenReady().
//
//  3. `on()` is NOT addEventListener: it pushes into the element's own listener
//     map, which bun drives by evaluating
//     `document.querySelector('#electrobun-webview-N').emit(...)` in this
//     webview. `off()` with the same function reference is the only way to
//     unsubscribe.
import { useCallback, useEffect, useRef, useState } from "react"
import type { PointerEvent as ReactPointerEvent } from "react"
// Type-only: erased at build time, so this never becomes a runtime import of
// electrobun/view (which only resolves inside the app — see lib/rpc.ts).
import type { WebviewTagElement } from "electrobun/view"
import {
  ArrowLeftIcon,
  ArrowPathIcon,
  ArrowRightIcon,
  ArrowTopRightOnSquareIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline"
import { isHttpUrl, normalizeUrl, MIN_PANE_PX, type BrowserRequest } from "../lib/browser"
import { openExternal } from "../lib/rpc"

/**
 * Host-webview UI that must paint ON TOP of the pane. The native webview is an
 * OS overlay composited above the HTML document, so without these the modals
 * and composer popovers would be hidden behind it. The element turns each
 * selector into a punch-through rect every sync tick, so newly-mounted overlays
 * are picked up automatically — the selectors are registered once, not the
 * elements.
 *
 * Passed as the `masks` attribute at creation time (parsed before the async id
 * round-trip) rather than via addMaskSelector(), which would silently do
 * nothing during the window where webviewId is still null.
 */
const MASK_SELECTORS = [
  // ConfirmModal, WaitModal and OnboardingWizard all share this backdrop.
  ".chunky-onboarding-backdrop",
  // The dismissible connection-error bar.
  ".chunky-conn-error",
  // Model / advisor / skills composer popovers all render as .chunky-model-menu.
  ".chunky-model-menu",
  // The add-repo popover in the TopNav.
  ".chunky-repo-menu",
]

/** True once Electrobun's preload has registered the custom element. In the
 *  plain Vite dev browser it never is, and we show a placeholder instead. */
function webviewSupported(): boolean {
  return typeof window !== "undefined" && !!customElements.get("electrobun-webview")
}

/** Resolve once the element has its native id (see note 2 above), or false if it
 *  never arrives. ~5s is far longer than the round-trip actually takes; it only
 *  exists so a failed init can't leave a promise pending forever. */
async function whenReady(el: WebviewTagElement): Promise<boolean> {
  for (let i = 0; i < 100; i++) {
    if (el.webviewId != null) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return false
}

export function BrowserPane({
  open,
  request,
  width,
  suppressed,
  cefAvailable,
  onWidthChange,
  onClose,
  onNavigate,
}: {
  open: boolean
  request: BrowserRequest | null
  width: number
  /** Run the pane on Chromium (CDP-drivable) instead of the system WebView.
   *  Sourced from the bun process's build.json — false in native-only builds
   *  and in the dev browser, where we fall back to "native" rather than asking
   *  for a renderer this build can't provide. */
  cefAvailable: boolean
  /** Hide the native overlay outright — used while a full-screen modal is up, so
   *  a slow mask sync can never leave the pane painted over a dialog. */
  suppressed: boolean
  onWidthChange: (px: number) => void
  onClose: () => void
  /** Fires when the webview navigates itself, so the URL can be remembered. */
  onNavigate: (url: string) => void
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<WebviewTagElement | null>(null)
  const [supported] = useState(webviewSupported)

  // What the URL bar shows. Kept out of sync with the live URL only while the
  // user is typing in it (editingRef), so navigation events can't yank the text
  // out from under a half-typed address.
  const [urlText, setUrlText] = useState(request?.url ?? "")
  const [loading, setLoading] = useState(false)
  const [canBack, setCanBack] = useState(false)
  const [canForward, setCanForward] = useState(false)
  const editingRef = useRef(false)
  const inputRef = useRef<HTMLInputElement>(null)
  /** Last URL the webview actually committed to — what Escape restores. */
  const currentUrlRef = useRef(request?.url ?? "")

  // Latest values for use inside the long-lived create effect, which must not
  // re-run (and tear down the native webview) just because a callback changed.
  const requestRef = useRef(request)
  requestRef.current = request
  const onNavigateRef = useRef(onNavigate)
  onNavigateRef.current = onNavigate
  /** seq of the request already applied, so we don't re-navigate on re-render. */
  const appliedSeqRef = useRef<number | null>(null)

  const refreshHistory = useCallback(async (el: WebviewTagElement) => {
    try {
      const [back, forward] = await Promise.all([el.canGoBack(), el.canGoForward()])
      setCanBack(back)
      setCanForward(forward)
    } catch {
      /* webview went away mid-flight */
    }
  }, [])

  /** Navigate, gated on readiness and on the http(s) allowlist. Every path that
   *  reaches loadURL goes through here. */
  const navigateTo = useCallback(async (el: WebviewTagElement, url: string) => {
    if (!isHttpUrl(url)) return
    setLoading(true)
    if (!editingRef.current) setUrlText(url)
    currentUrlRef.current = url
    if (!(await whenReady(el))) return
    el.loadURL(url)
  }, [])

  // ---- Create / destroy the native webview --------------------------------
  //
  // Deliberately keyed on `open` alone: closing the pane destroys the webview
  // and re-opening rebuilds it at the remembered URL. Keeping a hidden overlay
  // alive risks it stranding on screen, and the "persist:browser" partition
  // means cookies and logins survive the round trip regardless.
  useEffect(() => {
    if (!open || !supported) return
    const host = hostRef.current
    if (!host) return

    const el = document.createElement("electrobun-webview")
    // All of these are read once, at connect time — set them before appending.
    //
    // CEF gives the pane a Chrome DevTools Protocol listener (see
    // electrobun.config.ts), which is what makes it agent-drivable. The tag API
    // is renderer-agnostic: electrobun passes `renderer` straight through to the
    // native layer and only loadHTML() branches on it (we use loadURL/src), so
    // events, masking and syncDimensions behave the same either way. Falling
    // back to "native" when CEF wasn't bundled keeps the pane working — just
    // without CDP.
    el.setAttribute("renderer", cefAvailable ? "cef" : "native")
    el.setAttribute("partition", "persist:browser")
    // Untrusted remote content: no preload, no RPC to bun, events only.
    el.setAttribute("sandbox", "")
    el.setAttribute("masks", MASK_SELECTORS.join(","))
    const initial = requestRef.current
    if (initial && isHttpUrl(initial.url)) {
      // Seeding `src` here (rather than calling loadURL after mount) is what
      // makes the first page load race-free: initWebview passes it straight to
      // bun, so there's no window where the id is still null.
      el.setAttribute("src", initial.url)
      appliedSeqRef.current = initial.seq
      currentUrlRef.current = initial.url
    }
    el.style.width = "100%"
    el.style.height = "100%"
    el.style.display = "block"

    const onCommit = (e: CustomEvent) => {
      // Fires as a navigation starts committing — the address is already the new
      // one, but the page is still loading.
      const detail: unknown = e.detail
      if (typeof detail === "string" && isHttpUrl(detail)) {
        currentUrlRef.current = detail
        if (!editingRef.current) setUrlText(detail)
        onNavigateRef.current(detail)
      }
      setLoading(true)
      void refreshHistory(el)
    }

    const onNavigated = (e: CustomEvent) => {
      const detail: unknown = e.detail
      if (typeof detail === "string" && isHttpUrl(detail)) {
        currentUrlRef.current = detail
        if (!editingRef.current) setUrlText(detail)
        onNavigateRef.current(detail)
      }
      setLoading(false)
      void refreshHistory(el)
      // Native back/forward history can settle a beat after the event; re-check
      // so the arrows don't sit stale until the next navigation.
      setTimeout(() => void refreshHistory(el), 250)
    }

    const onDomReady = () => {
      setLoading(false)
      void refreshHistory(el)
    }

    const onNewWindow = (e: CustomEvent) => {
      // target="_blank" / window.open inside the pane. There's only one pane, so
      // adopt the navigation instead of dropping it on the floor.
      const detail: unknown = e.detail
      const target =
        typeof detail === "string"
          ? detail
          : detail && typeof detail === "object" && "url" in detail
            ? String((detail as { url: unknown }).url)
            : ""
      if (target && isHttpUrl(target)) void navigateTo(el, target)
    }

    el.on("did-commit-navigation", onCommit)
    el.on("did-navigate", onNavigated)
    el.on("did-navigate-in-page", onNavigated)
    el.on("dom-ready", onDomReady)
    el.on("new-window-open", onNewWindow)

    host.appendChild(el)
    viewRef.current = el

    // The overlay is positioned in native coordinates, so any layout change on
    // this side has to be pushed down. syncDimensions() only does work when
    // called with force=true.
    const ro = new ResizeObserver(() => el.syncDimensions(true))
    ro.observe(host)
    const onWindowChange = () => el.syncDimensions(true)
    window.addEventListener("resize", onWindowChange)
    window.addEventListener("scroll", onWindowChange, true)

    return () => {
      ro.disconnect()
      window.removeEventListener("resize", onWindowChange)
      window.removeEventListener("scroll", onWindowChange, true)
      el.off("did-commit-navigation", onCommit)
      el.off("did-navigate", onNavigated)
      el.off("did-navigate-in-page", onNavigated)
      el.off("dom-ready", onDomReady)
      el.off("new-window-open", onNewWindow)
      viewRef.current = null
      appliedSeqRef.current = null
      // disconnectedCallback tells bun to tear down the native webview.
      el.remove()
    }
  }, [open, supported, cefAvailable, refreshHistory, navigateTo])

  // ---- Apply navigation requests coming from outside (link clicks, toolbar) --
  useEffect(() => {
    if (!open || !supported || !request) return
    if (appliedSeqRef.current === request.seq) return
    const el = viewRef.current
    if (!el) return
    appliedSeqRef.current = request.seq
    void navigateTo(el, request.url)
  }, [open, supported, request, navigateTo])

  // ---- Hide the overlay while a modal owns the screen ----------------------
  useEffect(() => {
    if (!open || !supported) return
    const el = viewRef.current
    if (!el) return
    let cancelled = false
    void (async () => {
      if (!(await whenReady(el)) || cancelled) return
      el.toggleHidden(suppressed)
      if (!suppressed) el.syncDimensions(true)
    })()
    return () => {
      cancelled = true
    }
  }, [suppressed, open, supported])

  // Width changes move the overlay; ResizeObserver catches most of it, but a
  // forced sync keeps the drag from visibly trailing the divider.
  useEffect(() => {
    viewRef.current?.syncDimensions(true)
  }, [width])

  // ---- Divider drag --------------------------------------------------------
  const onDividerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      e.preventDefault()
      const handle = e.currentTarget
      handle.setPointerCapture(e.pointerId)
      const startX = e.clientX
      const startWidth = width
      // The split container — its width is the budget both panes share.
      const containerWidth = rootRef.current?.parentElement?.getBoundingClientRect().width ?? 0

      const onMove = (ev: PointerEvent) => {
        // The pane is on the RIGHT, so dragging left (negative dx) widens it.
        const next = startWidth - (ev.clientX - startX)
        const max = Math.max(MIN_PANE_PX, containerWidth - MIN_PANE_PX)
        onWidthChange(Math.min(max, Math.max(MIN_PANE_PX, Math.round(next))))
      }
      const onUp = () => {
        handle.removeEventListener("pointermove", onMove)
        handle.removeEventListener("pointerup", onUp)
        handle.removeEventListener("pointercancel", onUp)
        viewRef.current?.syncDimensions(true)
      }
      handle.addEventListener("pointermove", onMove)
      handle.addEventListener("pointerup", onUp)
      handle.addEventListener("pointercancel", onUp)
    },
    [width, onWidthChange],
  )

  // ---- Toolbar actions -----------------------------------------------------
  const submitUrl = useCallback(() => {
    const next = normalizeUrl(urlText)
    if (!next) return
    editingRef.current = false
    inputRef.current?.blur()
    const el = viewRef.current
    if (el) void navigateTo(el, next)
    else setUrlText(next)
  }, [urlText, navigateTo])

  const onReloadOrStop = useCallback(() => {
    const el = viewRef.current
    if (!el) return
    if (loading) {
      // The tag exposes no stopLoading(); window.stop() in the page is the
      // equivalent and works on sandboxed content (bun evaluates it natively).
      el.executeJavascript("window.stop()")
      setLoading(false)
      return
    }
    setLoading(true)
    el.reload()
  }, [loading])

  if (!open) return null

  return (
    <div className="chunky-browser" style={{ width: `${width}px` }} ref={rootRef}>
      <div
        className="chunky-browser-divider"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize browser pane"
        onPointerDown={onDividerDown}
      />
      <div className="chunky-browser-body">
        <div className="chunky-browser-toolbar">
          <button
            type="button"
            className="chunky-browser-btn"
            onClick={() => viewRef.current?.goBack()}
            disabled={!canBack}
            aria-label="Back"
            title="Back"
          >
            <ArrowLeftIcon />
          </button>
          <button
            type="button"
            className="chunky-browser-btn"
            onClick={() => viewRef.current?.goForward()}
            disabled={!canForward}
            aria-label="Forward"
            title="Forward"
          >
            <ArrowRightIcon />
          </button>
          <button
            type="button"
            className={`chunky-browser-btn${loading ? " chunky-browser-btn-spin" : ""}`}
            onClick={onReloadOrStop}
            disabled={!supported}
            aria-label={loading ? "Stop" : "Reload"}
            title={loading ? "Stop" : "Reload"}
          >
            {loading ? <XMarkIcon /> : <ArrowPathIcon />}
          </button>
          <input
            ref={inputRef}
            className="chunky-browser-url"
            value={urlText}
            spellCheck={false}
            autoComplete="off"
            aria-label="Address"
            placeholder="Search or enter address"
            onChange={(e) => setUrlText(e.target.value)}
            onFocus={() => {
              editingRef.current = true
              inputRef.current?.select()
            }}
            onBlur={() => {
              editingRef.current = false
              setUrlText(currentUrlRef.current)
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault()
                submitUrl()
              } else if (e.key === "Escape") {
                // Don't let Esc bubble to the composer's stop-the-run handler.
                e.preventDefault()
                e.stopPropagation()
                setUrlText(currentUrlRef.current)
                editingRef.current = false
                inputRef.current?.blur()
              }
            }}
          />
          <button
            type="button"
            className="chunky-browser-btn"
            // Unchanged /login path: hands the URL to the OS default browser.
            onClick={() => void openExternal(currentUrlRef.current)}
            disabled={!currentUrlRef.current}
            aria-label="Open in system browser"
            title="Open in system browser"
          >
            <ArrowTopRightOnSquareIcon />
          </button>
          <button
            type="button"
            className="chunky-browser-btn"
            onClick={onClose}
            aria-label="Close browser pane"
            title="Close browser pane"
          >
            <XMarkIcon />
          </button>
        </div>
        <div className="chunky-browser-view" ref={hostRef}>
          {!supported ? (
            <div className="chunky-browser-placeholder">
              <p className="chunky-browser-placeholder-title">Browser available in the desktop app</p>
              <p className="chunky-browser-placeholder-body">
                This pane embeds a native webview, which only exists inside the Chunky desktop
                app. Run <code>bun run app</code> to use it.
              </p>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
