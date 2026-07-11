import { useCallback, useEffect, useRef, useState } from "react"
import type { SessionSummary } from "@chunky/protocol"
import { AppShell } from "@astryxdesign/core/AppShell"
import { SideNav, SideNavItem, SideNavSection } from "@astryxdesign/core/SideNav"
import { TopNav, TopNavHeading } from "@astryxdesign/core/TopNav"
import {
  ChatBubbleLeftRightIcon,
  MagnifyingGlassIcon,
  PlusIcon,
} from "@heroicons/react/24/outline"
import { ChatPane } from "./components/ChatPane"
import { RepoTabs } from "./components/RepoTabs"
import {
  addRepo,
  createSession,
  fetchModel,
  interruptSession,
  listRepos,
  listSessions,
  loadConfig,
  openEventStream,
  prettyModel,
  removeRepo,
  sendMessage,
  type AppConfig,
  type ModelSelection,
  type Repo,
} from "./lib/api"

// Which repo tab is open is THIS CLIENT's UI state (the server has no global
// active workspace anymore) — remembered locally so a relaunch restores it.
const ACTIVE_REPO_KEY = "chunky.activeRepoId"
import { groupSessions, relativeTime, threadLabel } from "./lib/format"
import { initialState, reduce, type TranscriptState } from "./lib/transcript"

export default function App() {
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [transcript, setTranscript] = useState<TranscriptState>(initialState)
  const [draft, setDraft] = useState("")
  const [model, setModel] = useState<ModelSelection | null>(null)
  const [repos, setRepos] = useState<Repo[]>([])
  const [activeRepoId, setActiveRepoId] = useState<string | null>(null)
  const [connError, setConnError] = useState<string | null>(null)
  const [booting, setBooting] = useState(true)

  const sessionIdRef = useRef<string | null>(null)
  const streamAbort = useRef<AbortController | null>(null)
  const activeRepoIdRef = useRef<string | null>(null)
  sessionIdRef.current = sessionId
  activeRepoIdRef.current = activeRepoId

  const applyEvent = useCallback((ev: Parameters<typeof reduce>[1]) => {
    setTranscript((s) => reduce(s, ev))
  }, [])

  const refreshSessions = useCallback(
    async (baseUrl: string, repoId: string | null = activeRepoIdRef.current) => {
      try {
        const list = await listSessions(baseUrl, repoId)
        setSessions(list)
        setConnError(null)
        return list
      } catch (err) {
        setConnError(
          `Can't reach Chunky server at ${baseUrl}. Start it with \`bun run server\`. (${(err as Error).message})`,
        )
        return [] as SessionSummary[]
      }
    },
    [],
  )

  const attachSession = useCallback(
    async (baseUrl: string, id: string, reset = true) => {
      streamAbort.current?.abort()
      const ac = new AbortController()
      streamAbort.current = ac
      setSessionId(id)
      if (reset) setTranscript(initialState)
      setConnError(null)

      try {
        await openEventStream(baseUrl, id, applyEvent, ac.signal)
      } catch (err) {
        if (ac.signal.aborted) return
        setConnError(`SSE disconnected: ${(err as Error).message}`)
      }
    },
    [applyEvent],
  )

  // Open a repo's thread list: attach the most recent thread, or create a fresh
  // one (pinned to that repo) if it has none yet. Shared by boot, repo switch,
  // and add-repo.
  const openRepoThreads = useCallback(
    async (baseUrl: string, repoId: string | null) => {
      const list = await refreshSessions(baseUrl, repoId)
      if (list.length > 0) {
        void attachSession(baseUrl, list[0]!.sessionId, true)
        return
      }
      try {
        const id = await createSession(baseUrl, repoId)
        await refreshSessions(baseUrl, repoId)
        void attachSession(baseUrl, id, true)
      } catch (err) {
        setConnError(
          `Can't create a session — is the server running at ${baseUrl}? (${(err as Error).message})`,
        )
      }
    },
    [attachSession, refreshSessions],
  )

  // Boot: load config + repos, then open the active repo's threads.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const cfg = await loadConfig()
      if (cancelled) return
      setConfig(cfg)

      const [reg, sel] = await Promise.all([
        listRepos(cfg.baseUrl).catch(() => null),
        fetchModel(cfg.baseUrl),
      ])
      if (cancelled) return
      setModel(sel)

      let repoId: string | null = null
      if (reg) {
        // Last tab this client had open (if it still exists), else the server default.
        const remembered = localStorage.getItem(ACTIVE_REPO_KEY)
        repoId =
          (remembered && reg.repos.some((r) => r.id === remembered) ? remembered : null) ??
          reg.activeId
        setRepos(reg.repos)
        setActiveRepoId(repoId)
        activeRepoIdRef.current = repoId
      }

      await openRepoThreads(cfg.baseUrl, repoId)
      if (cancelled) return
      setBooting(false)
    })()
    return () => {
      cancelled = true
      streamAbort.current?.abort()
    }
  }, [openRepoThreads])

  // Poll model selection lightly so /model changes in TUI show up.
  useEffect(() => {
    if (!config) return
    const t = setInterval(() => {
      void fetchModel(config.baseUrl).then((m) => m && setModel(m))
    }, 15_000)
    return () => clearInterval(t)
  }, [config])

  const handleNewThread = useCallback(async () => {
    if (!config) return
    try {
      const id = await createSession(config.baseUrl, activeRepoIdRef.current)
      await refreshSessions(config.baseUrl)
      void attachSession(config.baseUrl, id, true)
    } catch (err) {
      setConnError((err as Error).message)
    }
  }, [attachSession, config, refreshSessions])

  const handleSelectSession = useCallback(
    (id: string) => {
      if (!config || id === sessionId) return
      void attachSession(config.baseUrl, id, true)
    },
    [attachSession, config, sessionId],
  )

  // Switching tabs is a pure client-side view change: sessions are pinned to
  // their repo server-side, so nothing global moves — runs in other repos keep
  // streaming untouched.
  const handleSelectRepo = useCallback(
    async (id: string) => {
      if (!config || id === activeRepoId) return
      setActiveRepoId(id)
      activeRepoIdRef.current = id
      localStorage.setItem(ACTIVE_REPO_KEY, id)
      await openRepoThreads(config.baseUrl, id)
    },
    [config, activeRepoId, openRepoThreads],
  )

  // Adds a folder (server validates it). Throws propagate to the RepoTabs form
  // so it can show "not a directory" inline. The new repo becomes this client's
  // open tab.
  const handleAddRepo = useCallback(
    async (path: string) => {
      if (!config) return
      const reg = await addRepo(config.baseUrl, path)
      setRepos(reg.repos)
      // The server makes a freshly added repo its default (activeId) — open it here too.
      const openId = reg.activeId
      setActiveRepoId(openId)
      activeRepoIdRef.current = openId
      if (openId) localStorage.setItem(ACTIVE_REPO_KEY, openId)
      await openRepoThreads(config.baseUrl, openId)
    },
    [config, openRepoThreads],
  )

  const handleRemoveRepo = useCallback(
    async (id: string) => {
      if (!config) return
      try {
        const wasOpen = id === activeRepoIdRef.current
        const reg = await removeRepo(config.baseUrl, id)
        setRepos(reg.repos)
        // Removing the open tab: fall back to the server default (never removable).
        if (wasOpen) {
          const openId = reg.activeId
          setActiveRepoId(openId)
          activeRepoIdRef.current = openId
          if (openId) localStorage.setItem(ACTIVE_REPO_KEY, openId)
          await openRepoThreads(config.baseUrl, openId)
        }
      } catch (err) {
        setConnError((err as Error).message)
      }
    },
    [config, openRepoThreads],
  )

  const handleSubmit = useCallback(
    async (text: string) => {
      const trimmed = text.trim()
      if (!trimmed || !config || !sessionId) return
      setDraft("")
      // The server echoes the user turn back over SSE (message.user), so we
      // don't optimistically insert it here — that keeps a single source of
      // truth and means resumed threads show past prompts too.
      try {
        const blocked = await sendMessage(config.baseUrl, sessionId, trimmed)
        if (blocked) {
          // Cache guard: the send did NOT run. Confirm before re-sending the
          // whole context, or hand the draft back untouched.
          const w = blocked.warning
          const why =
            w.reason === "model-switch"
              ? "a model switch"
              : `~${Math.round((w.idleMs ?? 0) / 60_000)}m idle`
          const ok = window.confirm(
            `Prompt cache went cold after ${why} — sending will re-send ~${w.approxTokens.toLocaleString()} tokens. Send anyway?`,
          )
          if (!ok) {
            setDraft(text)
            return
          }
          await sendMessage(config.baseUrl, sessionId, trimmed, true)
        }
        void refreshSessions(config.baseUrl)
      } catch (err) {
        setConnError((err as Error).message)
      }
    },
    [config, refreshSessions, sessionId],
  )

  const handleStop = useCallback(() => {
    if (!config || !sessionId) return
    void interruptSession(config.baseUrl, sessionId)
  }, [config, sessionId])

  const activeRepo = repos.find((r) => r.id === activeRepoId) ?? null
  const workspaceName = activeRepo?.name || config?.workspaceName || "chunky"
  const modelLabel = model
    ? [prettyModel(model.model), model.effort, model.speed].filter(Boolean).join(" · ")
    : null
  const groups = groupSessions(sessions)

  return (
    <div className="chunky-shell">
      <AppShell
        height="fill"
        variant="elevated"
        contentPadding={0}
        topNav={
          <TopNav
            label="Repositories"
            heading={
              <TopNavHeading
                heading="Chunky"
                logo={
                  <span className="chunky-avatar" aria-hidden="true">
                    <img className="chunky-mark" src="/chunky-mark.png" alt="" />
                  </span>
                }
              />
            }
            startContent={
              <RepoTabs
                repos={repos}
                activeId={activeRepoId}
                onSelect={(id) => void handleSelectRepo(id)}
                onAdd={handleAddRepo}
                onRemove={(id) => void handleRemoveRepo(id)}
              />
            }
            endContent={
              modelLabel ? (
                <span
                  className="chunky-status-pill"
                  style={{ marginInlineEnd: 8 }}
                  title={model?.provider ? `Provider: ${model.provider}` : undefined}
                >
                  {modelLabel}
                </span>
              ) : null
            }
          />
        }
        sideNav={
          <SideNav
            collapsible
            // Codex-style anchored actions: "New thread" and "Search" live in the
            // SideNav's pinned `topContent` zone, so they stay put while only the
            // thread groups below scroll. This keeps the scrollbar short and makes
            // it start *below* these rows instead of running the full sidebar
            // height right next to the chat pane's rounded top corner.
            topContent={
              <SideNavSection title="Quick actions" isHeaderHidden>
                <SideNavItem
                  label="New thread"
                  icon={PlusIcon}
                  onClick={() => void handleNewThread()}
                />
                <SideNavItem
                  label="Search"
                  icon={MagnifyingGlassIcon}
                  onClick={() => {}}
                />
              </SideNavSection>
            }
          >
            {sessions.length === 0 ? (
              <SideNavSection title="Threads" isHeaderHidden>
                <SideNavItem
                  label={booting ? "Loading…" : "No threads yet"}
                  icon={ChatBubbleLeftRightIcon}
                  isDisabled
                />
              </SideNavSection>
            ) : (
              groups.map((group) => (
                <SideNavSection key={group.band} title={group.band}>
                  {group.sessions.map((s) => (
                    <SideNavItem
                      key={s.sessionId}
                      label={threadLabel(s.title)}
                      icon={ChatBubbleLeftRightIcon}
                      isSelected={s.sessionId === sessionId}
                      onClick={() => handleSelectSession(s.sessionId)}
                      endContent={
                        <span className="chunky-thread-time">
                          {relativeTime(s.lastActivity)}
                        </span>
                      }
                    />
                  ))}
                </SideNavSection>
              ))
            )}
          </SideNav>
        }
      >
        {connError ? <div className="chunky-conn-error">{connError}</div> : null}
        <ChatPane
          state={transcript}
          workspaceName={workspaceName}
          baseUrl={config?.baseUrl}
          repoId={activeRepoId}
          draft={draft}
          onDraftChange={setDraft}
          onSubmit={(t) => void handleSubmit(t)}
          onStop={handleStop}
          onSuggestion={(t) => void handleSubmit(t)}
        />
      </AppShell>
    </div>
  )
}
