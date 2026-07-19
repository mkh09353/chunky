import { useCallback, useEffect, useRef, useState } from "react"
import { MINIMAP_MIN_ENTRIES, USER_ANCHOR_CLASS, type MinimapEntry } from "../lib/minimap"

/** A message counts as "the one you're reading" once its top passes this far into
 *  the viewport — a band rather than the exact top edge, so the active bar changes
 *  at the moment a prompt actually becomes the thing on screen. */
const ACTIVE_BAND_PX = 120

/** Breathing room left above a jumped-to message, so it doesn't sit flush against
 *  the top edge with its avatar clipped. */
const JUMP_PADDING_PX = 24

function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches
}

/**
 * Slim navigation gutter down the left edge of the chat viewport: one bar per
 * main-thread user message, hover for a preview card, click to jump.
 *
 * POSITIONING — index-based, deliberately.
 * Bars are spread evenly by ordinal rather than by each anchor's measured
 * offsetTop. Measured positions look more "correct" in principle, but Task A puts
 * `content-visibility: auto` on message rows, so off-screen content is sized from
 * `contain-intrinsic-size` estimates rather than real layout. Pixel-proportional
 * bars would therefore drift and re-shuffle as you scroll and estimates get
 * replaced by real sizes — visible jitter in a control whose whole job is to be a
 * stable map. Ordinal spacing is immune to that: bar N never moves.
 *
 * Measurement is still used where it must be exact and is always accurate for the
 * element in question: deciding which bar is ACTIVE, and computing the scroll
 * offset for a JUMP. Both read a live getBoundingClientRect on demand.
 *
 * Lives OUTSIDE the scroll container (absolutely positioned in .chunky-chat-wrap)
 * so it adds nothing to the scrolled content and cannot perturb ChatPane's
 * at-bottom tracking or re-pin logic.
 */
export function TranscriptMinimap({
  scrollRef,
  entries,
  bottomInset,
}: {
  /** ChatLayout's self-scrolling root — the element that owns scrollTop. */
  scrollRef: React.RefObject<HTMLDivElement | null>
  entries: MinimapEntry[]
  /** Height of the sticky composer dock, so the gutter stops above it. */
  bottomInset: number
}) {
  const [active, setActive] = useState(0)
  const [hovered, setHovered] = useState<number | null>(null)
  const rafRef = useRef<number | null>(null)

  const visible = entries.length > MINIMAP_MIN_ENTRIES

  /** Anchors, live from the DOM and always in document order. */
  const readAnchors = useCallback((): HTMLElement[] => {
    const el = scrollRef.current
    if (!el) return []
    return Array.from(el.querySelectorAll<HTMLElement>(`.${USER_ANCHOR_CLASS}`))
  }, [scrollRef])

  // Track which prompt is at the top of the viewport. Recomputed on scroll, on
  // container resize, and on content growth (streaming) — all coalesced into one
  // rAF so a fast scroll or a chatty stream can't run this per event.
  useEffect(() => {
    if (!visible) return
    const el = scrollRef.current
    if (!el) return

    const measure = () => {
      rafRef.current = null
      const anchors = readAnchors()
      if (anchors.length === 0) return
      const top = el.getBoundingClientRect().top
      // The last anchor that has already crossed into the band is the one being read.
      let idx = 0
      for (let i = 0; i < anchors.length; i++) {
        if (anchors[i]!.getBoundingClientRect().top - top <= ACTIVE_BAND_PX) idx = i
        else break
      }
      setActive(idx)
    }

    const schedule = () => {
      if (rafRef.current == null) rafRef.current = requestAnimationFrame(measure)
    }

    schedule()
    el.addEventListener("scroll", schedule, { passive: true })
    // Container resize (window) AND content growth (streaming deltas, a sub-thread
    // expanding) both move anchors, and neither fires a scroll event on its own.
    const ro = new ResizeObserver(schedule)
    ro.observe(el)
    const content = el.querySelector(".chunky-transcript")
    if (content) ro.observe(content)

    return () => {
      el.removeEventListener("scroll", schedule)
      ro.disconnect()
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
  }, [scrollRef, readAnchors, visible, entries.length])

  // Scroll the container itself rather than target.scrollIntoView(): scrollIntoView
  // would also scroll ancestor scrollers (and fights the sticky composer dock).
  const jumpTo = useCallback(
    (index: number) => {
      const el = scrollRef.current
      const target = readAnchors()[index]
      if (!el || !target) return
      const delta = target.getBoundingClientRect().top - el.getBoundingClientRect().top
      el.scrollTo({
        top: el.scrollTop + delta - JUMP_PADDING_PX,
        behavior: prefersReducedMotion() ? "auto" : "smooth",
      })
      // No need to touch ChatPane's at-bottom flag: this is a real scroll with no
      // height change, so its scroll handler re-measures and unlatches by itself.
    },
    [readAnchors, scrollRef],
  )

  if (entries.length === 0) return null

  // Even ordinal spacing across the track. A single entry sits at the top rather
  // than dividing by zero.
  const fraction = (i: number) => (entries.length > 1 ? i / (entries.length - 1) : 0)

  return (
    <div
      className="chunky-minimap"
      style={{ bottom: bottomInset }}
      data-visible={visible || undefined}
      aria-hidden={!visible}
    >
      <nav
        className="chunky-minimap-strip"
        aria-label="Jump to a message"
        onMouseLeave={() => setHovered(null)}
      >
        {entries.map((entry, i) => (
          <button
            key={i}
            type="button"
            className="chunky-minimap-bar"
            style={{ top: `${fraction(i) * 100}%` }}
            data-active={i === active || undefined}
            tabIndex={visible ? 0 : -1}
            onMouseEnter={() => setHovered(i)}
            onFocus={() => setHovered(i)}
            onBlur={() => setHovered(null)}
            onClick={() => jumpTo(i)}
            aria-label={`Message ${i + 1} of ${entries.length}: ${entry.prompt}`}
          />
        ))}

        {hovered != null && entries[hovered] ? (
          <div
            className="chunky-minimap-preview"
            style={{ top: `${fraction(hovered) * 100}%` }}
            role="tooltip"
          >
            <span className="chunky-minimap-preview-prompt">{entries[hovered]!.prompt}</span>
            {entries[hovered]!.reply ? (
              <span className="chunky-minimap-preview-reply">{entries[hovered]!.reply}</span>
            ) : null}
          </div>
        ) : null}
      </nav>
    </div>
  )
}
