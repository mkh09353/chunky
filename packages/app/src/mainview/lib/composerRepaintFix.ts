/**
 * Workaround for a WKWebView (electrobun) partial-repaint bug in the chat
 * composer's contentEditable.
 *
 * The composer sits inside several `isolation: isolate` stacking contexts and
 * an `overflow: auto` scroller. In that setup WKWebView only partially
 * invalidates the text layer on each keystroke: freshly-typed glyphs paint with
 * incomplete coverage (faint / fragmented) and only settle to solid on a later
 * full repaint — so while you type, the text looks broken. Chromium repaints
 * cleanly, so this never shows in a browser tab, only in the shipped app.
 *
 * Neither `transform: translateZ(0)` nor `will-change` on the editable fixes it
 * (verified by screen-capturing the real window mid-type). Forcing an actual
 * recomposite after each input does: toggling `opacity` off unity for one frame
 * makes WebKit promote-then-flatten the layer, fully repainting the text. The
 * 0.999 → 1 flicker across a single frame is imperceptible.
 *
 * A single capturing `input` listener on the document covers the composer no
 * matter when it mounts/remounts. Guarded to WebKit-without-Chrome so it never
 * runs in the dev Chrome tab.
 */
export function installComposerRepaintFix(): void {
  const ua = navigator.userAgent
  const isWebKit = /AppleWebKit/.test(ua) && !/Chrome|Chromium/.test(ua)
  if (!isWebKit) return

  document.addEventListener("input", (e) => {
    const t = e.target
    if (!(t instanceof HTMLElement) || !t.isContentEditable) return
    if (!t.closest(".astryx-chat-composer-input")) return
    t.style.opacity = "0.999"
    requestAnimationFrame(() => {
      t.style.opacity = "1"
    })
  })
}
