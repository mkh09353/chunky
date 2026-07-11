import { useMemo } from "react"
import { ChatComposer, ChatComposerInput, ChatLayout } from "@astryxdesign/core/Chat"
import { hasTranscript, mainItems, type TranscriptState } from "../lib/transcript"
import { createMentionTrigger } from "./mentionTrigger"
import { EmptyChat } from "./EmptyChat"
import { TranscriptView } from "./TranscriptView"

export function ChatPane({
  state,
  workspaceName,
  baseUrl,
  draft,
  onDraftChange,
  onSubmit,
  onStop,
  onSuggestion,
}: {
  state: TranscriptState
  workspaceName: string
  baseUrl?: string
  draft: string
  onDraftChange: (v: string) => void
  onSubmit: (text: string) => void
  onStop: () => void
  onSuggestion: (text: string) => void
}) {
  const items = useMemo(() => mainItems(state), [state])
  const running = state.status === "running"
  const empty = !hasTranscript(state)

  // `@`-mention file autocomplete, backed by the active repo's FFF search.
  // Rebuilt per baseUrl so its AbortController-based SearchSource is scoped to
  // one server. Absent baseUrl → no trigger (plain input).
  const triggers = useMemo(
    () => (baseUrl ? [createMentionTrigger(baseUrl)] : undefined),
    [baseUrl],
  )

  return (
    <div className="chunky-chat-wrap">
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
                running ? (
                  <span className="chunky-status-pill chunky-status-live">
                    Running…
                  </span>
                ) : undefined
              }
            />
          </div>
        }
      >
        {!empty ? <TranscriptView items={items} /> : null}
      </ChatLayout>
    </div>
  )
}
