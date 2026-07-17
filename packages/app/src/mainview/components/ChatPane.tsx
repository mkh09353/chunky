import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ChatComposer, ChatComposerInput, ChatLayout } from "@astryxdesign/core/Chat"
import type { CacheCold, GoalSnapshot, ModeInfo } from "@chunky/protocol"
import type { AdvisorState, InputImage, ModelSelection } from "../lib/api"
import { fmtTokens } from "../lib/format"
import { hasTranscript, type TranscriptState } from "../lib/transcript"
import { createMentionTrigger } from "./mentionTrigger"
import { createSlashTrigger } from "./slashTrigger"
import { AdvisorPickerMenu } from "./AdvisorPickerMenu"
import { EmptyChat } from "./EmptyChat"
import { ModelPickerMenu } from "./ModelPickerMenu"
import { SkillsBrowserMenu } from "./SkillsBrowserMenu"
import { TranscriptView } from "./TranscriptView"

// Mirror the TUI's clipboard-image cap (~7MB of base64) — bigger pastes are
// skipped rather than resized.
const MAX_IMAGE_BASE64_LENGTH = 7_000_000

/** Short human phrase for WHY the cache is cold: "42m idle" / "model switch". */
function coldReason(w: CacheCold): string {
  if (w.reason === "model-switch") {
    const models = w.fromModel && w.toModel ? ` (${w.fromModel} → ${w.toModel})` : ""
    return `model switch${models}`
  }
  const mins = w.idleMs != null ? Math.round(w.idleMs / 60_000) : 0
  return `${mins}m idle`
}

/** The running pill with a live elapsed-seconds counter (TUI status-line parity). */
function RunningPill({ since }: { since: number | null }) {
  const [, setTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [])
  const secs = since != null ? Math.max(0, Math.floor((Date.now() - since) / 1000)) : null
  return (
    <span className="chunky-status-pill chunky-status-live">
      Running…{secs != null ? ` ${secs}s` : ""}
    </span>
  )
}

export function ChatPane({
  state,
  workspaceName,
  baseUrl,
  repoId,
  model,
  onModelChange,
  modes,
  onRefreshModes,
  advisor,
  onAdvisorChange,
  goal,
  cacheCold,
  runningSince,
  attachmentCount,
  onAttachImage,
  onClearAttachments,
  sessionId,
  pendingSkill,
  onClearSkill,
  onSelectSkill,
  modelOpenSignal,
  advisorOpenSignal,
  skillsOpenSignal,
  draft,
  onDraftChange,
  onSubmit,
  onStop,
  onSuggestion,
  transcriptLoading,
  queueCount,
  connectionState,
}: {
  state: TranscriptState
  workspaceName: string
  baseUrl?: string
  repoId?: string | null
  model: ModelSelection | null
  onModelChange: (sel: ModelSelection) => void
  /** Saved modes, surfaced as `/<name>` entries in the slash menu. */
  modes: ModeInfo[]
  /** Refetch saved modes (called when the `/` menu opens, to stay fresh). */
  onRefreshModes: () => void
  advisor: AdvisorState | null
  onAdvisorChange: (a: AdvisorState) => void
  goal: GoalSnapshot | null
  /** Idle pre-send warning: the NEXT send would rebuild this cold cache. */
  cacheCold: CacheCold | null
  runningSince: number | null
  attachmentCount: number
  onAttachImage: (img: InputImage) => void
  onClearAttachments: () => void
  sessionId: string | null
  /** Skill queued for the next message (shown as a clearable composer chip). */
  pendingSkill: string | null
  onClearSkill: () => void
  onSelectSkill: (name: string) => void
  modelOpenSignal?: number
  advisorOpenSignal?: number
  skillsOpenSignal?: number
  draft: string
  onDraftChange: (v: string) => void
  onSubmit: (text: string, opts?: { interject?: boolean }) => void
  onStop: () => void
  onSuggestion: (text: string) => void
  transcriptLoading?: boolean
  queueCount?: number
  connectionState?: "connecting" | "connected" | "reconnecting"
}) {
  const running = state.status === "running"
  const empty = !hasTranscript(state)
  const [imageNotice, setImageNotice] = useState(false)

  // Scroll re-pin. The message list and the composer share one scroll container
  // (ChatLayout's self-scrolling root, reachable via this ref). The library's
  // auto-follow only re-anchors on MESSAGE-content resize, so two moments can
  // strand a bottom-pinned view above the newest messages: focusing the composer
  // (sticky-dock reflow / scroll-into-view) and SENDING (the contentEditable
  // clears → dock shrinks, and a new bubble appends). We re-pin in both, but only
  // when the user was genuinely at the bottom — never yanking someone who scrolled
  // up to read back while a response streams.
  const layoutRef = useRef<HTMLDivElement>(null)
  const wasAtBottomRef = useRef(true)
  const repinRafRef = useRef<number | null>(null)

  // Distance (px) from the bottom within which the view counts as "pinned".
  const AT_BOTTOM_THRESHOLD = 40

  // Snap to the true bottom after layout settles. Two rAFs so the focus/send
  // reflow (dock resize, scroll-into-view, appended bubble) lands first. Never
  // touches focus or the caret; guarded so a late frame after unmount no-ops.
  const repinToBottom = useCallback(() => {
    if (repinRafRef.current != null) cancelAnimationFrame(repinRafRef.current)
    repinRafRef.current = requestAnimationFrame(() => {
      repinRafRef.current = requestAnimationFrame(() => {
        repinRafRef.current = null
        const el = layoutRef.current
        if (el) el.scrollTop = el.scrollHeight
      })
    })
  }, [])

  // Track whether the view is pinned to the bottom, immune to the sticky dock's
  // own growth: synthetic scrolls from content/composer resize (scrollHeight
  // changes) are ignored — mirroring the library's resize detection — so typing a
  // multi-line message never reads as a deliberate scroll-up. Explicit wheel/
  // touch up-gestures unlatch even mid-stream, when the height is changing and
  // the scroll handler bails.
  useEffect(() => {
    const el = layoutRef.current
    if (!el) return
    let lastScrollHeight = el.scrollHeight
    const measure = () =>
      el.scrollHeight - el.scrollTop - el.clientHeight <= AT_BOTTOM_THRESHOLD
    wasAtBottomRef.current = measure()

    const onScroll = () => {
      const heightChanged = el.scrollHeight !== lastScrollHeight
      lastScrollHeight = el.scrollHeight
      if (heightChanged) return
      wasAtBottomRef.current = measure()
    }
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) wasAtBottomRef.current = false
    }
    const onTouchMove = () => {
      wasAtBottomRef.current = measure()
    }
    el.addEventListener("scroll", onScroll, { passive: true })
    el.addEventListener("wheel", onWheel, { passive: true })
    el.addEventListener("touchmove", onTouchMove, { passive: true })
    return () => {
      el.removeEventListener("scroll", onScroll)
      el.removeEventListener("wheel", onWheel)
      el.removeEventListener("touchmove", onTouchMove)
    }
  }, [])

  // Re-pin when focus lands in the composer while pinned (matches "clicks into
  // the input box"). Scoped to the composer's `.chunky-readable` wrapper so
  // transcript/nav focus never triggers it.
  const handleFocusCapture = useCallback(
    (e: React.FocusEvent) => {
      if (!wasAtBottomRef.current) return
      const target = e.target as HTMLElement
      if (!target.closest?.(".chunky-readable")) return
      repinToBottom()
    },
    [repinToBottom],
  )

  // Wrap the send so a bottom-pinned view follows the just-sent message (and the
  // streaming reply). Read the pinned state BEFORE handing off to the parent,
  // which clears the draft and mutates the DOM.
  const handleSubmit = useCallback(
    (text: string, opts?: { interject?: boolean }) => {
      const atBottom = wasAtBottomRef.current
      onSubmit(text, opts)
      if (atBottom) repinToBottom()
    },
    [onSubmit, repinToBottom],
  )

  useEffect(() => {
    return () => {
      if (repinRafRef.current != null) cancelAnimationFrame(repinRafRef.current)
    }
  }, [])

  // `@`-mention file autocomplete (backed by the current repo's FFF search) plus
  // the `/` slash-command menu. Rebuilt per baseUrl + repo so the mention
  // trigger's AbortController-based SearchSource is scoped to one server and one
  // repo index. Absent baseUrl → plain input.
  // Read the latest modes through a ref so the slash trigger reflects /mode
  // save|rm without rebuilding the trigger (and its SearchSource) each change.
  const modesRef = useRef<ModeInfo[]>(modes)
  modesRef.current = modes
  const triggers = useMemo(
    () =>
      baseUrl
        ? [
            createMentionTrigger(baseUrl, repoId),
            createSlashTrigger({ getModes: () => modesRef.current, refreshModes: onRefreshModes }),
          ]
        : undefined,
    [baseUrl, repoId, onRefreshModes],
  )

  // Paste-to-attach: an image on the clipboard becomes an attachment on the next
  // message (the browser equivalent of the TUI's Ctrl+V flow). Listens on the
  // whole pane so it works wherever focus sits; text pastes pass through.
  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const files: File[] = []
      for (const item of Array.from(e.clipboardData?.items ?? [])) {
        if (item.kind === "file" && item.type.startsWith("image/")) {
          const f = item.getAsFile()
          if (f) files.push(f)
        }
      }
      if (files.length === 0) return
      e.preventDefault()
      for (const f of files) {
        const reader = new FileReader()
        reader.onload = () => {
          const url = String(reader.result ?? "")
          const comma = url.indexOf(",")
          if (comma === -1) return
          const base64 = url.slice(comma + 1)
          if (!base64 || base64.length > MAX_IMAGE_BASE64_LENGTH) {
            setImageNotice(true)
            window.setTimeout(() => setImageNotice(false), 3000)
            return
          }
          onAttachImage({ base64, mediaType: f.type || "image/png" })
        }
        reader.readAsDataURL(f)
      }
    },
    [onAttachImage],
  )

  // Esc on an empty composer clears a queued skill (TUI parity). The skills
  // menu handles its own Esc while focused, so this only fires when the popover
  // is closed and focus sits in the composer.
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        // Pickers/menus (model, advisor, skills) stopPropagation + preventDefault
        // their own Esc, so those never reach here. When nothing owns it: an
        // empty composer with a queued skill clears the skill (TUI parity),
        // otherwise a running turn is stopped — same action as the Stop button.
        if (e.defaultPrevented) return
        if (pendingSkill && !draft.trim()) {
          e.preventDefault()
          onClearSkill()
          return
        }
        if (running) {
          e.preventDefault()
          onStop()
        }
        return
      }
      // Option+Enter interjects immediately while a turn is running, rather
      // than adding the message to the normal prompt queue.
      if (
        e.key === "Enter" &&
        e.altKey &&
        !e.shiftKey &&
        !e.metaKey &&
        !e.ctrlKey &&
        running &&
        e.target instanceof HTMLElement &&
        e.target.isContentEditable
      ) {
        e.preventDefault()
        if (draft.trim()) handleSubmit(draft, { interject: true })
        return
      }
      // Cmd+Enter → send, mirroring plain Enter (the Astryx composer only submits
      // on Enter without Shift, so Cmd+Enter would otherwise do nothing). Reuse
      // the controlled onSubmit flow, which trims-guards and clears the draft.
      if (
        e.key === "Enter" &&
        e.metaKey &&
        !e.shiftKey &&
        !e.ctrlKey &&
        !e.altKey &&
        e.target instanceof HTMLElement &&
        e.target.isContentEditable
      ) {
        e.preventDefault()
        if (draft.trim()) handleSubmit(draft)
        return
      }
      // Shift+Enter → newline. The Astryx composer submits on plain Enter and
      // lets Shift+Enter fall through to the browser, but WebKit wraps the new
      // line in a <div> which the composer's serializer drops. Insert a real
      // <br> instead (serialized as "\n", and the input event keeps the
      // controlled value in sync).
      if (
        e.key === "Enter" &&
        e.shiftKey &&
        e.target instanceof HTMLElement &&
        e.target.isContentEditable
      ) {
        e.preventDefault()
        if (!document.execCommand("insertLineBreak")) document.execCommand("insertHTML", false, "<br>")
      }
    },
    [pendingSkill, draft, running, onClearSkill, onStop, handleSubmit],
  )

  return (
    <div
      className="chunky-chat-wrap"
      onPaste={handlePaste}
      onKeyDown={handleKeyDown}
      onFocusCapture={handleFocusCapture}
    >
      <ChatLayout
        ref={layoutRef}
        density="balanced"
        scrollButton={empty ? null : undefined}
        emptyState={
          empty ? (
            <EmptyChat workspaceName={workspaceName} onPick={onSuggestion} loading={transcriptLoading} />
          ) : undefined
        }
        composer={
          <div className="chunky-readable">
            {imageNotice ? <div className="chunky-image-notice" role="status">Image too large — 7MB max</div> : null}
            {cacheCold && !running ? (
              // Early heads-up while idle (TUI parity): the next send would
              // rebuild a cold cache — warn BEFORE the tokens are spent.
              <div className="chunky-cache-banner" role="status">
                ⚠ Cache cold ({coldReason(cacheCold)}) — next message re-sends ~
                {fmtTokens(cacheCold.approxTokens)} tokens. Consider a fresh thread.
              </div>
            ) : null}
            <ChatComposer
              value={draft}
              onChange={onDraftChange}
              onSubmit={handleSubmit}
              onStop={onStop}
              isStopShown={running}
              placeholder={`Message Chunky about ${workspaceName}…`}
              isDisabled={false}
              // Replace the default input with one that carries the `@`-mention
              // trigger. It still reads value/onChange/onSubmit/placeholder from
              // ChatComposer's context, so behaviour is otherwise unchanged.
              input={<ChatComposerInput triggers={triggers} />}
              footerActions={
                <>
                  {running ? <RunningPill since={runningSince} /> : null}
                  {queueCount != null && queueCount > 0 ? (
                    <span className="chunky-queue-pill" role="status">
                      ⏎ queued: {queueCount}
                    </span>
                  ) : null}
                  {connectionState === "reconnecting" ? (
                    <span className="chunky-reconnect-pill" role="status">
                      reconnecting…
                    </span>
                  ) : null}
                  {goal ? (
                    <span className="chunky-status-pill" title={goal.objective}>
                      goal: {goal.status}
                      {goal.status === "active" ? ` ${goal.turns}/${goal.maxTurns}` : ""}
                    </span>
                  ) : null}
                  {attachmentCount > 0 ? (
                    <span className="chunky-attach-chip">
                      📎 {attachmentCount} image{attachmentCount === 1 ? "" : "s"}
                      <button
                        type="button"
                        className="chunky-attach-clear"
                        aria-label="Remove attached images"
                        title="Remove attached images"
                        onClick={onClearAttachments}
                      >
                        ×
                      </button>
                    </span>
                  ) : null}
                  {pendingSkill ? (
                    <span className="chunky-attach-chip chunky-skill-chip" title={`Skill queued for your next message: ${pendingSkill}`}>
                      ✦ skill: {pendingSkill}
                      <button
                        type="button"
                        className="chunky-attach-clear"
                        aria-label="Clear queued skill"
                        title="Clear queued skill"
                        onClick={onClearSkill}
                      >
                        ×
                      </button>
                    </span>
                  ) : null}
                </>
              }
              // Codex-style advisor + model pickers in the bottom-right, next to
              // the send button.
              sendActions={
                baseUrl ? (
                  <>
                    <SkillsBrowserMenu
                      baseUrl={baseUrl}
                      sessionId={sessionId}
                      onSelect={onSelectSkill}
                      openSignal={skillsOpenSignal}
                    />
                    <AdvisorPickerMenu
                      baseUrl={baseUrl}
                      advisor={advisor}
                      onAdvisorChange={onAdvisorChange}
                      openSignal={advisorOpenSignal}
                    />
                    <ModelPickerMenu
                      baseUrl={baseUrl}
                      model={model}
                      onModelChange={onModelChange}
                      openSignal={modelOpenSignal}
                    />
                  </>
                ) : undefined
              }
            />
          </div>
        }
      >
        {!empty ? <TranscriptView state={state} /> : null}
      </ChatLayout>
    </div>
  )
}
