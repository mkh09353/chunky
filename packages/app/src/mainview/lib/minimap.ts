// Data for the transcript minimap: one entry per MAIN-THREAD user message, with a
// snippet of the reply it drew. Pure and derived from the reducer state, so it
// stays a display concern (like renderPlan) and needs no extra bookkeeping in the
// event log.
import { MAIN, type TranscriptState } from "./transcript"

/**
 * Marker class on the <article> of every main-thread user message. The minimap
 * finds its jump targets with a single querySelectorAll for this class.
 *
 * WHY A CLASS AND NOT AN id / data-attribute: Astryx's <ChatMessage> destructures
 * a fixed prop set and does NOT spread rest props, so `id` and `data-*` are
 * silently dropped — but `className` IS forwarded (merged onto the root <article>
 * via mergeProps). A class is therefore the only prop-level hook available, and it
 * conveniently yields the anchors already in document order.
 *
 * Scoped to the main thread on purpose: child threads collapse to a preview line,
 * so their user turns have no stable on-screen position to jump to.
 */
export const USER_ANCHOR_CLASS = "chunky-user-anchor"

/** Below this many user turns the thread is short enough to scroll by hand, and a
 *  gutter of 2-3 bars is more clutter than navigation. */
export const MINIMAP_MIN_ENTRIES = 5

/** How much of the reply to keep for the hover card's second line. */
const REPLY_SNIPPET_CHARS = 140
/** How much of the prompt to keep for the hover card's first line. */
const PROMPT_SNIPPET_CHARS = 120

export interface MinimapEntry {
  /** The user's prompt, collapsed to one line. */
  prompt: string
  /** Start of the assistant's reply to it, or "" if it never answered. */
  reply: string
}

/** Collapse whitespace and clip, so a pasted multi-line prompt reads as one line. */
function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/**
 * One entry per main-thread user message, in document order — index-aligned with
 * the `.chunky-user-anchor` elements the minimap queries, so bar N always describes
 * anchor N.
 *
 * The reply is the first assistant message with real text AFTER that prompt and
 * BEFORE the next one; a turn that only ran tools (or is still streaming its first
 * token) yields "" and the card shows just the prompt.
 */
export function buildMinimapEntries(state: TranscriptState): MinimapEntry[] {
  const items = state.threads[MAIN]?.items ?? []
  const entries: MinimapEntry[] = []

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!
    if (item.kind !== "user") continue

    let reply = ""
    for (let j = i + 1; j < items.length; j++) {
      const next = items[j]!
      // Stop at the next prompt: anything past it belongs to the following turn.
      if (next.kind === "user") break
      if (next.kind === "assistant" && next.text.trim()) {
        reply = oneLine(next.text, REPLY_SNIPPET_CHARS)
        break
      }
    }

    entries.push({ prompt: oneLine(item.text, PROMPT_SNIPPET_CHARS), reply })
  }

  return entries
}
