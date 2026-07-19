import { useCallback, useEffect, useState, useSyncExternalStore } from "react"
import { TabList, Tab } from "@astryxdesign/core/TabList"
import {
  ChatBubbleLeftRightIcon,
  CommandLineIcon,
  PlusIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline"
import { TerminalPane } from "./TerminalPane"
import { nativeRpcAvailable } from "../lib/rpc"
import {
  adoptTerminal,
  closeTerminal,
  getTerminalsSnapshot,
  listRunningTerminals,
  openTerminal,
  subscribeTerminals,
} from "../lib/terminalRuntime"

const CHAT_PANE = "chat"

/**
 * The main content area's pane switcher: a "Chat" tab plus one tab per built-in
 * terminal, modelled on RepoTabs (same Astryx TabList/Tab, same hover-close) so
 * the two strips read as one system.
 *
 * Deliberately NOT related to repo tabs: repos scope the conversation, panes
 * only choose what you're looking at. Chat is passed as `children` and keeps
 * its existing always-mounted behavior (its scroll position and streaming state
 * are React state); terminals unmount here but survive in lib/terminalRuntime.
 *
 * Outside electrobun (plain `vite dev` in a browser) there is no bun process to
 * spawn a PTY, so the whole strip collapses to just the chat.
 */
export function WorkspacePanes({
  repoPath,
  children,
}: {
  repoPath?: string | null
  children: React.ReactNode
}) {
  const native = nativeRpcAvailable()
  const terminals = useSyncExternalStore(subscribeTerminals, getTerminalsSnapshot)
  const [active, setActive] = useState<string>(CHAT_PANE)

  // Dev webview reloads throw away this registry while the PTYs keep running on
  // the bun side — re-adopt them so the tabs (and scrollback) come back.
  useEffect(() => {
    if (!native) return
    let cancelled = false
    void (async () => {
      const running = await listRunningTerminals()
      if (cancelled) return
      let n = 0
      for (const info of running) {
        n += 1
        if (info.status !== "running") continue
        await adoptTerminal(info, info.title || `Terminal ${n}`)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [native])

  const addTerminal = useCallback(async () => {
    const terminalId = crypto.randomUUID()
    // Number by position rather than a running counter so closing and reopening
    // doesn't march the labels off to "Terminal 47".
    const title = `Terminal ${getTerminalsSnapshot().length + 1}`
    setActive(terminalId)
    await openTerminal({ terminalId, title, cwd: repoPath ?? undefined })
  }, [repoPath])

  const close = useCallback(
    (terminalId: string) => {
      const remaining = getTerminalsSnapshot().filter((t) => t.terminalId !== terminalId)
      closeTerminal(terminalId)
      // Only move if we closed the tab being viewed; fall back to a sibling
      // terminal, else the chat.
      setActive((cur) =>
        cur === terminalId ? (remaining[0]?.terminalId ?? CHAT_PANE) : cur,
      )
    },
    [],
  )

  // A terminal tab can vanish underneath us (process exited + closed elsewhere).
  useEffect(() => {
    if (active === CHAT_PANE) return
    if (!terminals.some((t) => t.terminalId === active)) setActive(CHAT_PANE)
  }, [active, terminals])

  if (!native) return <>{children}</>

  return (
    <div className="chunky-panes">
      <div className="chunky-panetabs">
        <TabList value={active} onChange={setActive} size="sm" layout="hug">
          <Tab
            value={CHAT_PANE}
            label="Chat"
            icon={<ChatBubbleLeftRightIcon style={{ width: 14, height: 14 }} />}
          />
          {terminals.map((t) => (
            <Tab
              key={t.terminalId}
              value={t.terminalId}
              label={t.status === "exited" ? `${t.title} (exited)` : t.title}
              icon={<CommandLineIcon style={{ width: 14, height: 14 }} />}
              endContent={
                <span
                  className="chunky-repotab-close"
                  role="button"
                  tabIndex={0}
                  aria-label={`Close ${t.title}`}
                  title={`Close ${t.title}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    close(t.terminalId)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault()
                      e.stopPropagation()
                      close(t.terminalId)
                    }
                  }}
                >
                  <XMarkIcon style={{ width: 12, height: 12 }} />
                </span>
              }
            />
          ))}
        </TabList>
        <button
          type="button"
          className="chunky-repotab-add"
          aria-label="New terminal"
          title="New terminal"
          onClick={() => void addTerminal()}
        >
          <PlusIcon style={{ width: 16, height: 16 }} />
        </button>
      </div>

      {/* Chat stays mounted and merely hidden: unmounting it would drop the
          transcript's scroll position and any in-flight streaming state. */}
      <div className="chunky-pane" hidden={active !== CHAT_PANE}>
        {children}
      </div>
      {active !== CHAT_PANE ? (
        <div className="chunky-pane">
          <TerminalPane terminalId={active} />
        </div>
      ) : null}
    </div>
  )
}
