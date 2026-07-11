import { useMemo } from "react"
import { ChatComposer, ChatLayout } from "@astryxdesign/core/Chat"
import { hasTranscript, mainItems, type TranscriptState } from "../lib/transcript"
import { EmptyChat } from "./EmptyChat"
import { TranscriptView } from "./TranscriptView"

export function ChatPane({
  state,
  workspaceName,
  draft,
  onDraftChange,
  onSubmit,
  onStop,
  onSuggestion,
}: {
  state: TranscriptState
  workspaceName: string
  draft: string
  onDraftChange: (v: string) => void
  onSubmit: (text: string) => void
  onStop: () => void
  onSuggestion: (text: string) => void
}) {
  const items = useMemo(() => mainItems(state), [state])
  const running = state.status === "running"
  const empty = !hasTranscript(state)

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
