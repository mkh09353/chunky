import { useCallback, useEffect, useMemo, useState } from "react"
import { ChatComposer, ChatComposerInput, ChatLayout } from "@astryxdesign/core/Chat"
import type { CacheCold, GoalSnapshot } from "@chunky/protocol"
import type { AdvisorState, InputImage, ModelSelection } from "../lib/api"
import { fmtTokens } from "../lib/format"
import { hasTranscript, type TranscriptState } from "../lib/transcript"
import { createMentionTrigger } from "./mentionTrigger"
import { createSlashTrigger } from "./slashTrigger"
import { AdvisorPickerMenu } from "./AdvisorPickerMenu"
import { EmptyChat } from "./EmptyChat"
import { ModelPickerMenu } from "./ModelPickerMenu"
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
  advisor,
  onAdvisorChange,
  goal,
  cacheCold,
  runningSince,
  attachmentCount,
  onAttachImage,
  onClearAttachments,
  modelOpenSignal,
  advisorOpenSignal,
  draft,
  onDraftChange,
  onSubmit,
  onStop,
  onSuggestion,
}: {
  state: TranscriptState
  workspaceName: string
  baseUrl?: string
  repoId?: string | null
  model: ModelSelection | null
  onModelChange: (sel: ModelSelection) => void
  advisor: AdvisorState | null
  onAdvisorChange: (a: AdvisorState) => void
  goal: GoalSnapshot | null
  /** Idle pre-send warning: the NEXT send would rebuild this cold cache. */
  cacheCold: CacheCold | null
  runningSince: number | null
  attachmentCount: number
  onAttachImage: (img: InputImage) => void
  onClearAttachments: () => void
  modelOpenSignal?: number
  advisorOpenSignal?: number
  draft: string
  onDraftChange: (v: string) => void
  onSubmit: (text: string) => void
  onStop: () => void
  onSuggestion: (text: string) => void
}) {
  const running = state.status === "running"
  const empty = !hasTranscript(state)

  // `@`-mention file autocomplete (backed by the current repo's FFF search) plus
  // the `/` slash-command menu. Rebuilt per baseUrl + repo so the mention
  // trigger's AbortController-based SearchSource is scoped to one server and one
  // repo index. Absent baseUrl → plain input.
  const triggers = useMemo(
    () => (baseUrl ? [createMentionTrigger(baseUrl, repoId), createSlashTrigger()] : undefined),
    [baseUrl, repoId],
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
          if (!base64 || base64.length > MAX_IMAGE_BASE64_LENGTH) return
          onAttachImage({ base64, mediaType: f.type || "image/png" })
        }
        reader.readAsDataURL(f)
      }
    },
    [onAttachImage],
  )

  return (
    <div className="chunky-chat-wrap" onPaste={handlePaste}>
      <ChatLayout
        density="balanced"
        scrollButton={empty ? null : undefined}
        emptyState={
          empty ? (
            <EmptyChat workspaceName={workspaceName} onPick={onSuggestion} />
          ) : undefined
        }
        composer={
          <div className="chunky-readable">
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
              onSubmit={onSubmit}
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
                </>
              }
              // Codex-style advisor + model pickers in the bottom-right, next to
              // the send button.
              sendActions={
                baseUrl ? (
                  <>
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
