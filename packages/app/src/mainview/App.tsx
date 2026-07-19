import { useCallback, useEffect, useRef, useState } from "react"
import type { CacheCold, GoalSnapshot, ModeInfo, ModeSpec, SessionSummary, TodoSnapshot } from "@chunky/protocol"
import { AppShell } from "@astryxdesign/core/AppShell"
import { SideNav, SideNavItem, SideNavSection } from "@astryxdesign/core/SideNav"
import { TopNav, TopNavHeading } from "@astryxdesign/core/TopNav"
import { ChatBubbleLeftRightIcon, GlobeAltIcon, PlusIcon } from "@heroicons/react/24/outline"
import { ChatPane } from "./components/ChatPane"
import { BrowserPane } from "./components/BrowserPane"
import { RepoTabs } from "./components/RepoTabs"
import { WorkspacePanes } from "./components/WorkspacePanes"
import {
  addRepo,
  applyMode,
  createSession,
  deleteMode,
  fetchAdvisor,
  fetchCacheGuard,
  fetchCacheStatus,
  fetchGoal,
  fetchTodos,
  fetchModel,
  fetchModes,
  initiateLogin,
  interruptSession,
  listProviders,
  listRepos,
  getRepositoryInstructions,
  setRepositoryInstructions,
  listSessions,
  loadConfig,
  loginStatus,
  fetchOnboarding,
  completeOnboarding,
  getSkills,
  manageSkillRepos,
  openEventStream,
  postGoal,
  prettyModel,
  QueueFullError,
  removeRepo,
  renameSession,
  saveMode,
  THREAD_TITLE_MAX,
  sendMessage,
  setCacheGuard,
  shipSession,
  type AdvisorState,
  type AppConfig,
  type InputImage,
  type MessageDelivery,
  type ModelSelection,
  type Repo,
} from "./lib/api"
import { openExternal } from "./lib/rpc"
import { BrowserProvider, useBrowserPane } from "./lib/browser"
import { sleep } from "./lib/sleep"
import { isIntentionalAbort, reconnectDelay } from "./lib/reconnect"
import { parseGoalArgs, parseSlashCommand, SLASH_COMMANDS } from "./lib/commands"
import { fmtTokens } from "./lib/format"
import { OnboardingWizard } from "./components/OnboardingWizard"
import { ConfirmModal, WaitModal } from "./components/Modals"

import { groupSessions, isPlaceholderTitle, relativeTime, threadLabel } from "./lib/format"
import { ThreadRenameInput } from "./components/ThreadRenameInput"
import { MIN_NOTIFY_MS, notifyTurnEnd } from "./lib/notify"
import { ThemeToggle } from "./components/ThemeToggle"
import { isThemeMode, systemTheme, THEME_MODES, useThemeMode } from "./lib/theme"
import { initialState, pushNotice, reduce, type TranscriptState } from "./lib/transcript"

// Which repo tab is open is THIS CLIENT's UI state (the server has no global
// active workspace anymore) — remembered locally so a relaunch restores it.
const ACTIVE_REPO_KEY = "chunky.activeRepoId"

// Grace period after the stream opens before the empty state is allowed to show.
// The server replays history immediately on attach but never marks the end of it,
// so we let the replayed events land first; a genuinely empty thread just shows
// its empty state this much later.
const REPLAY_SETTLE_MS = 150

export default function App() {
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [transcript, setTranscript] = useState<TranscriptState>(initialState)
  const [draft, setDraft] = useState("")
  const [model, setModel] = useState<ModelSelection | null>(null)
  const [repos, setRepos] = useState<Repo[]>([])
  const [activeRepoId, setActiveRepoId] = useState<string | null>(null)
  const [agentsMdEnabled, setAgentsMdEnabled] = useState(true)
  // True across the whole add-a-repo round-trip (server validation + opening the
  // new repo's threads). Drives RepoTabs' disabled/spinner state — the native
  // picker hands back instantly, but registering can take a beat.
  const [addingRepo, setAddingRepo] = useState(false)
  // Bumped to ask ChatPane to focus the composer and put the caret at the end.
  const [composerFocusSignal, setComposerFocusSignal] = useState(0)
  // Thread whose sidebar row is currently an inline rename box (null = none).
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [connError, setConnError] = useState<string | null>(null)
  // Health of the event stream, tracked SEPARATELY from connError: connError is
  // for actionable, dismissible failures (a send that didn't land, a session that
  // wouldn't create), while this is the live attachment state. Dismissing the
  // error bar must never hide an in-progress reconnect.
  const [connectionState, setConnectionState] = useState<
    "connecting" | "connected" | "reconnecting"
  >("connecting")
  const [booting, setBooting] = useState(true)
  // True from an attach until its stream is open and history has settled. Gates
  // the empty state so it can't flash over a conversation that's still loading.
  const [transcriptLoading, setTranscriptLoading] = useState(true)
  // The cache-guard confirmation (M1): handleSubmit parks a resolver here and
  // awaits the user's answer, so the async send reads like the old `confirm()`.
  const [confirmPrompt, setConfirmPrompt] = useState<{
    title: string
    body: string
    confirmLabel: string
    resolve: (ok: boolean) => void
  } | null>(null)
  // Provider id whose browser sign-in we're polling for (drives the WaitModal).
  const [loginWait, setLoginWait] = useState<string | null>(null)
  // The always-on advisor config (composer trigger label + /advisor).
  const [advisor, setAdvisorState] = useState<AdvisorState | null>(null)
  // The session's current goal (composer pill; tracked from goal.update events).
  const [goal, setGoal] = useState<GoalSnapshot | null>(null)
  // The session's todo checklist (composer checklist pill; tracked from
  // todos.update events, seeded from REST on attach like the goal).
  const [todos, setTodos] = useState<TodoSnapshot[]>([])
  // Passive cold-cache indicator: while idle, the NEXT send would re-send this
  // much context. Shown above the composer so the warning lands BEFORE you send.
  const [cacheCold, setCacheCold] = useState<CacheCold | null>(null)
  // Saved modes double as direct slash commands (/fire applies the "fire" mode)
  // and as `/` menu entries. A ref mirrors the list so handleSubmit matches
  // typed slash text without a stale closure.
  const [modes, setModes] = useState<ModeInfo[]>([])
  const modesRef = useRef<ModeInfo[]>([])
  // Images pasted onto the NEXT message. A ref mirrors it so handleSubmit reads
  // the latest set without going stale in its closure.
  const [attachments, setAttachments] = useState<InputImage[]>([])
  const attachmentsRef = useRef<InputImage[]>([])
  attachmentsRef.current = attachments
  // Wall-clock start of the in-flight turn (drives the elapsed-seconds pill).
  const [runningSince, setRunningSince] = useState<number | null>(null)
  // Bumped by /model and /advisor to open the corresponding composer menu.
  const [modelOpenSignal, setModelOpenSignal] = useState(0)
  // The built-in browser pane (open/closed, width, current URL) — all of its
  // state and persistence lives in the hook so this file only gains a line.
  const browser = useBrowserPane()
  const [advisorOpenSignal, setAdvisorOpenSignal] = useState(0)
  // Bumped by bare /skills to open the composer's skills browser.
  const [skillsOpenSignal, setSkillsOpenSignal] = useState(0)
  // Skill queued for the NEXT message: injected server-side for that turn only,
  // then cleared. Shown as a clearable composer chip.
  const [pendingSkill, setPendingSkill] = useState<string | null>(null)
  // Mirror the queued skill so handleSubmit reads the latest without going stale.
  const pendingSkillRef = useRef<string | null>(null)
  pendingSkillRef.current = pendingSkill
  const [onboardingOpen, setOnboardingOpen] = useState(false)
  // Appearance setting (system/light/dark). Owned by ThemeModeProvider in main.tsx;
  // read here so /theme can drive the same state as the TopNav toggle.
  const { setMode: setThemeMode, cycleMode: cycleTheme } = useThemeMode()

  const sessionIdRef = useRef<string | null>(null)
  const streamAbort = useRef<AbortController | null>(null)
  const activeRepoIdRef = useRef<string | null>(null)
  // Latest run state for handleSubmit, which picks the send's delivery. A ref, so
  // reading it doesn't rebuild the callback on every streamed event.
  const runningRef = useRef(false)
  runningRef.current = transcript.status === "running"
  // Aborts the /login poll loop (Cancel button, or App unmount).
  const loginAbort = useRef<AbortController | null>(null)
  const settleTimer = useRef<number | null>(null)
  sessionIdRef.current = sessionId
  activeRepoIdRef.current = activeRepoId

  // Ask the user a yes/no question in-app and await the answer.
  const pendingConfirmRef = useRef<((ok: boolean) => void) | null>(null)
  const askConfirm = useCallback(
    (opts: { title: string; body: string; confirmLabel: string }) =>
      new Promise<boolean>((resolve) => {
        // Only one question fits on screen. If a second is asked while one is
        // pending, decline the first rather than leaving its caller awaiting a
        // promise that can never settle — handleSubmit holds the user's draft in
        // that await, so a hang there loses the message.
        pendingConfirmRef.current?.(false)
        const settle = (ok: boolean) => {
          pendingConfirmRef.current = null
          setConfirmPrompt(null)
          resolve(ok)
        }
        pendingConfirmRef.current = settle
        setConfirmPrompt({ ...opts, resolve: settle })
      }),
    [],
  )

  // Never leave a poll loop or a settle timer running past unmount.
  useEffect(
    () => () => {
      loginAbort.current?.abort()
      if (settleTimer.current != null) clearTimeout(settleTimer.current)
    },
    [],
  )

  useEffect(() => {
    if (!config || !activeRepoId) { setAgentsMdEnabled(true); return }
    void getRepositoryInstructions(config.baseUrl, activeRepoId)
      .then((value) => setAgentsMdEnabled(value.enabled))
      .catch(() => setAgentsMdEnabled(true))
  }, [config, activeRepoId])

  const toggleAgentsMd = useCallback(async (enabled: boolean) => {
    if (!config || !activeRepoIdRef.current) return
    const value = await setRepositoryInstructions(config.baseUrl, activeRepoIdRef.current, enabled)
    setAgentsMdEnabled(value.enabled)
  }, [config])

  // Turn-end notification bookkeeping: when the run started (wall clock, so
  // replayed history — processed in ms — never notifies) and the final
  // assistant text of the turn (accumulated from main-thread deltas).
  const runningSinceRef = useRef<number | null>(null)
  const lastAssistantRef = useRef("")

  const applyEvent = useCallback((ev: Parameters<typeof reduce>[1]) => {
    setTranscript((s) => reduce(s, ev))
    if (ev.type === "message.start" && !ev.threadId) lastAssistantRef.current = ""
    if (ev.type === "message.delta" && !ev.threadId) lastAssistantRef.current += ev.text
    if (ev.type === "session.status") {
      setRunningSince(ev.status === "running" ? Date.now() : null)
      if (ev.status === "running") {
        runningSinceRef.current = Date.now()
      } else {
        const since = runningSinceRef.current
        runningSinceRef.current = null
        if (since != null && Date.now() - since >= MIN_NOTIFY_MS) notifyTurnEnd(lastAssistantRef.current)
      }
    }
    // Track goal state for the composer pill. History replay (resume) re-runs
    // these in order, so the last one wins and the pill reflects the true state.
    if (ev.type === "goal.update") setGoal(ev.goal)
    // Last-wins snapshot: every todos.update carries the WHOLE list, so replay
    // and live updates converge on the same state without merging.
    if (ev.type === "todos.update") setTodos(ev.todos)
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
      setTranscriptLoading(true)
      // Per-session UI state must not leak across threads. goal.update events
      // replay over SSE, but a session with no goal never emits one — so seed
      // from the REST snapshot rather than trusting replay alone.
      setGoal(null)
      setTodos([])
      setCacheCold(null)
      setAttachments([])
      setPendingSkill(null)
      void fetchGoal(baseUrl, id).then(setGoal).catch(() => {})
      void fetchTodos(baseUrl, id).then(setTodos)

      // The stream is live: let the replayed history land before the empty state
      // is allowed to render.
      const onOpen = () => {
        setConnectionState("connected")
        if (settleTimer.current != null) clearTimeout(settleTimer.current)
        settleTimer.current = window.setTimeout(() => {
          settleTimer.current = null
          if (!ac.signal.aborted) setTranscriptLoading(false)
        }, REPLAY_SETTLE_MS)
      }

      // A healthy stream resets the backoff, so an attachment that survived hours
      // before dropping retries at the base delay rather than the last cap.
      let attempt = 0
      const onEvent = (ev: Parameters<typeof applyEvent>[0]) => {
        attempt = 0
        applyEvent(ev)
      }

      // Reconnect ladder (mirrors the TUI's, see lib/reconnect.ts). There is no
      // resume cursor — every reattach replays the session's FULL history — so the
      // transcript is reset before each retry; otherwise the replay would render
      // on top of what we already have and double every message.
      for (;;) {
        try {
          setConnectionState(attempt === 0 ? "connecting" : "reconnecting")
          await openEventStream(baseUrl, id, onEvent, ac.signal, onOpen)
          // EOF is a disconnect even when the server closed cleanly (restart, a
          // proxy reaping an idle stream). Returning here would silently detach:
          // the UI keeps looking connected while no events can ever arrive again.
          if (ac.signal.aborted) return
          setConnectionState("reconnecting")
          // A healthy stream reset `attempt` to 0, so the first drop retries at
          // the base 500ms (as the TUI does). Unlike the TUI's flat `attempt = 1`,
          // repeated immediate EOFs — a server closing the stream as fast as we
          // open it — climb the ladder instead of hot-looping twice a second.
          attempt += 1
          await sleep(reconnectDelay(attempt - 1), ac.signal)
        } catch (err) {
          if (isIntentionalAbort(err, ac.signal)) return
          attempt += 1
          setConnectionState("reconnecting")
          setTranscriptLoading(false)
          await sleep(reconnectDelay(attempt), ac.signal)
        }
        if (ac.signal.aborted) return
        setTranscript(initialState)
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
        setTranscriptLoading(false)
        setConnError(
          `Can't create a session — is the server running at ${baseUrl}? (${(err as Error).message})`,
        )
      }
    },
    [attachSession, refreshSessions],
  )

  // Retry from the connection-error bar: reattach the open thread if there is
  // one (its own reconnect ladder takes over from there), else redo the repo's
  // thread bootstrap — which is what failed if we never got a session at all.
  const handleRetry = useCallback(async () => {
    if (!config) return
    setConnError(null)
    const id = sessionIdRef.current
    if (id) {
      void attachSession(config.baseUrl, id, true)
      return
    }
    await openRepoThreads(config.baseUrl, activeRepoIdRef.current)
  }, [config, attachSession, openRepoThreads])

  // Boot: load config + repos, then open the active repo's threads.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const cfg = await loadConfig()
      if (cancelled) return
      setConfig(cfg)
      void fetchOnboarding(cfg.baseUrl).then((p) => { if (!p.onboardedAt) setOnboardingOpen(true) }).catch(() => {})

      const [reg, sel, adv] = await Promise.all([
        listRepos(cfg.baseUrl).catch(() => null),
        fetchModel(cfg.baseUrl),
        fetchAdvisor(cfg.baseUrl),
      ])
      if (cancelled) return
      setModel(sel)
      setAdvisorState(adv)

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

  // Poll model + advisor selection lightly so TUI-side changes show up.
  useEffect(() => {
    if (!config) return
    const t = setInterval(() => {
      void fetchModel(config.baseUrl).then((m) => m && setModel(m))
      void fetchAdvisor(config.baseUrl).then((a) => a && setAdvisorState(a))
    }, 15_000)
    return () => clearInterval(t)
  }, [config])

  // Passive cold-cache watch (TUI parity): while the session is idle, ask the
  // server whether the NEXT send would rebuild a cold cache and warn above the
  // composer — BEFORE any tokens are spent — instead of after the turn starts.
  useEffect(() => {
    if (!config || !sessionId || transcript.status === "running") return
    let cancelled = false
    const check = async () => {
      const res = await fetchCacheStatus(config.baseUrl, sessionId)
      if (!cancelled && res) setCacheCold(res.cold)
    }
    void check()
    const t = setInterval(() => void check(), 30_000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [config, sessionId, transcript.status])

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

  // Commit an inline thread rename. Optimistic: the sidebar updates immediately
  // and rolls back if the server refuses, so a rename feels instant but can't
  // leave the list lying about what's stored.
  const commitRename = useCallback(
    async (id: string, next: string) => {
      setRenamingId(null)
      if (!config) return
      const previous = sessions.find((s) => s.sessionId === id)
      if (!previous) return
      // Match the server's normalization so the optimistic row shows exactly what
      // will be stored.
      const title = next.trim().slice(0, THREAD_TITLE_MAX)
      // Nothing to do: cleared, or identical to what's already there. The server
      // rejects an empty title outright (400), so don't even ask.
      if (!title || title === previous.title) return

      setSessions((list) =>
        list.map((s) => (s.sessionId === id ? { ...s, title } : s)),
      )
      try {
        await renameSession(config.baseUrl, id, title)
      } catch (err) {
        setSessions((list) =>
          list.map((s) => (s.sessionId === id ? { ...s, title: previous.title } : s)),
        )
        setConnError(`Couldn't rename that thread: ${(err as Error).message}`)
      }
    },
    [config, sessions],
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
  // so it can show "not a directory" inline — hence try/finally, not try/catch.
  // The new repo becomes this client's open tab.
  const handleAddRepo = useCallback(
    async (path: string) => {
      if (!config) return
      setAddingRepo(true)
      try {
        const reg = await addRepo(config.baseUrl, path)
        setRepos(reg.repos)
        // The server makes a freshly added repo its default (activeId) — open it here too.
        const openId = reg.activeId
        setActiveRepoId(openId)
        activeRepoIdRef.current = openId
        if (openId) localStorage.setItem(ACTIVE_REPO_KEY, openId)
        await openRepoThreads(config.baseUrl, openId)
      } finally {
        setAddingRepo(false)
      }
    },
    [config, openRepoThreads],
  )

  const handleRemoveRepo = useCallback(
    async (id: string) => {
      if (!config) return
      // Confirm first: the tab's × is a small target sitting on a tab you click
      // all day, and there's no undo. Spell out that it's list-only — people
      // reasonably fear a × next to a folder name deletes the folder.
      const repo = repos.find((r) => r.id === id)
      const ok = await askConfirm({
        title: `Remove ${repo?.name ?? "this repo"}?`,
        body: "This only takes it off your repo list — the folder, its files, and its threads all stay exactly where they are. You can add it back any time.",
        confirmLabel: "Remove",
      })
      if (!ok) return
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
    [askConfirm, config, repos, openRepoThreads],
  )

  // Client-local status line for slash-command feedback (never persisted —
  // the server's own goal.update/message events remain the durable record).
  const notice = useCallback((text: string) => {
    setTranscript((s) => pushNotice(s, text))
  }, [])

  // Refresh the saved-modes list (powers the `/` menu and the /<name> direct
  // slash-command matching). Kept quiet — a failed refresh keeps the last list.
  const refreshModes = useCallback(async () => {
    if (!config) return
    try {
      const body = await fetchModes(config.baseUrl)
      modesRef.current = body.modes
      setModes(body.modes)
    } catch {
      /* keep the previously loaded list */
    }
  }, [config])

  // Load saved modes once the server URL is known (TUI/onboarding may have
  // seeded "fire"/"cheap"). The `/` menu also refetches when it opens.
  useEffect(() => {
    void refreshModes()
  }, [refreshModes])

  // /login — bare lists providers; `/login <provider>` starts the browser
  // loopback flow (the server's callback captures the token) and polls until
  // the provider reports ready.
  const doLogin = useCallback(
    async (rest: string) => {
      if (!config) return
      const providers = await listProviders(config.baseUrl)
      if (providers.length === 0) {
        notice("No providers available (is the server running?).")
        return
      }
      const id = rest.trim().toLowerCase()
      if (!id) {
        const lines = providers.map(
          (p) =>
            `${p.ready ? "●" : "○"} ${p.id} — ${p.label}${p.ready ? " (logged in)" : ""}${p.active ? " (active)" : ""}`,
        )
        notice(`Providers: ${lines.join("  ·  ")}. \`/login <provider>\` starts a browser sign-in.`)
        return
      }
      const p = providers.find((x) => x.id.toLowerCase() === id)
      if (!p) {
        notice(`Unknown provider "${rest}". Available: ${providers.map((x) => x.id).join(", ")}.`)
        return
      }
      if (p.ready) {
        notice(`${p.id} is already logged in. Pick one of its models with /model.`)
        return
      }
      try {
        const init = await initiateLogin(config.baseUrl, p.id)
        if (init.kind === "ready") {
          notice(init.instructions)
          return
        }
        if (init.kind === "url") {
          const opened = await openExternal(init.url)
          notice(
            opened
              ? init.instructions
              : `Couldn't open a browser automatically. Open this URL to sign in to ${p.id}: ${init.url}`,
          )
        } else {
          notice(init.instructions)
        }
        // Poll until the server has stored a token (loopback callback fired).
        // Cancellable: the WaitModal's Cancel aborts this, as does unmount —
        // otherwise the loop ran its full 150s with no way to call it off.
        loginAbort.current?.abort()
        const ac = new AbortController()
        loginAbort.current = ac
        setLoginWait(p.id)
        try {
          const deadline = Date.now() + 150_000
          while (Date.now() < deadline) {
            await sleep(2000, ac.signal)
            if (ac.signal.aborted) {
              notice(`Stopped waiting on the ${p.id} sign-in. \`/login ${p.id}\` picks it back up.`)
              return
            }
            if (await loginStatus(config.baseUrl, p.id)) {
              notice(`✓ Logged in to ${p.id}. Pick one of its models with /model.`)
              return
            }
          }
          notice(`Still waiting on ${p.id} login. Finish in the browser, then pick a model with /model.`)
        } finally {
          setLoginWait(null)
          if (loginAbort.current === ac) loginAbort.current = null
        }
      } catch (err) {
        notice(`Login for ${p.id} failed: ${(err as Error).message}`)
      }
    },
    [config, notice],
  )

  // /cacheguard — show or set the confirm-before-resend threshold:
  //   ""                  -> show the current guard
  //   <N | Nk | Nm | off> -> set the threshold in tokens, or disable the guard
  const doCacheGuard = useCallback(
    async (rest: string) => {
      if (!config) return
      const trimmed = rest.trim().toLowerCase()
      if (!trimmed) {
        const body = await fetchCacheGuard(config.baseUrl)
        notice(
          body.tokens == null
            ? "Cache guard: off — cold-cache sends go through without confirmation. `/cacheguard <tokens>` (e.g. 100k) to enable."
            : `Cache guard: a send that would re-send ≥${fmtTokens(body.tokens)} tokens on a cold cache asks for confirmation first. \`/cacheguard <tokens|off>\` to change.`,
        )
        return
      }
      let tokens: number | null
      if (trimmed === "off" || trimmed === "none" || trimmed === "0") {
        tokens = null
      } else {
        const m = trimmed.match(/^(\d+(?:\.\d+)?)(k|m)?$/)
        if (!m) {
          notice("Usage: /cacheguard <tokens|off> — e.g. /cacheguard 100k, /cacheguard 50000, /cacheguard off")
          return
        }
        tokens = Math.round(Number(m[1]) * (m[2] === "m" ? 1_000_000 : m[2] === "k" ? 1_000 : 1))
      }
      const body = await setCacheGuard(config.baseUrl, tokens)
      notice(
        body.tokens == null
          ? "Cache guard off — cold-cache sends go through without confirmation."
          : `Cache guard set: confirm before re-sending ≥${fmtTokens(body.tokens)} tokens on a cold cache.`,
      )
    },
    [config, notice],
  )

  // /mode — named executor+advisor pairings:
  //   ""          -> list saved modes + the current pairing
  //   <name>      -> apply that mode (model + advisor switch as one unit)
  //   save <name> -> snapshot the current pairing under <name>
  //   rm <name>   -> delete <name>
  const doMode = useCallback(
    async (rest: string) => {
      if (!config) return
      const effortParen = (e?: string | null) => (e ? ` (${e})` : "")
      const fmtSpec = (spec: ModeSpec) =>
        `${prettyModel(spec.model)}${effortParen(spec.effort)} + advisor ${
          spec.advisor ? `${prettyModel(spec.advisor.model)}${effortParen(spec.advisor.effort)}` : "off"
        }`
      const trimmed = rest.trim()
      if (!trimmed) {
        const body = await fetchModes(config.baseUrl)
        if (body.modes.length === 0) {
          notice(
            `No modes saved. Current pairing: ${fmtSpec(body.current)}. \`/mode save <name>\` snapshots it; \`/mode <name>\` applies one.`,
          )
          return
        }
        const lines = body.modes.map((m) => `${m.name} — ${fmtSpec(m)}`)
        notice(`Modes: ${lines.join("  ·  ")}. Current: ${fmtSpec(body.current)}. \`/mode <name>\` to switch.`)
        return
      }

      const save = trimmed.match(/^save\s+(\S+)$/i)
      if (save) {
        const name = save[1]!
        const { current } = await fetchModes(config.baseUrl)
        await saveMode(config.baseUrl, name)
        void refreshModes()
        const samePair =
          current.advisor && current.advisor.provider === current.provider && current.advisor.model === current.model
        notice(
          `Mode "${name}" saved: ${fmtSpec(current)}.${
            samePair ? " ⚠ advisor equals the executor — it will be suppressed; pick a different advisor for this mode." : ""
          }`,
        )
        return
      }

      const rm = trimmed.match(/^(?:rm|delete)\s+(\S+)$/i)
      if (rm) {
        await deleteMode(config.baseUrl, rm[1]!)
        void refreshModes()
        notice(`Mode "${rm[1]}" deleted.`)
        return
      }

      // Anything else is a mode name to apply.
      const body = await applyMode(config.baseUrl, trimmed)
      setModel({
        provider: body.provider,
        model: body.model,
        effort: body.effort ?? null,
        speed: body.speed ?? null,
      })
      void fetchAdvisor(config.baseUrl).then((a) => a && setAdvisorState(a))
      void refreshModes()
      notice(`Mode "${body.applied}" applied: ${prettyModel(body.model)}${effortParen(body.effort)} · ${body.provider}.`)
    },
    [config, notice, refreshModes],
  )

  // /skills — manage git skill repositories (add/remove/update/list).
  const doSkills = useCallback(
    async (rest: string) => {
      if (!config) return
      // Bare /skills opens the human-facing browser (same affordance as the
      // composer's Skills button); subcommands manage the git repos below.
      if (!rest.trim()) {
        setSkillsOpenSignal((n) => n + 1)
        return
      }
      const parts = rest.split(/\s+/).filter(Boolean)
      const action = (parts[0] ?? "list").toLowerCase()
      if (!["add", "remove", "rm", "update", "list", "ls"].includes(action)) {
        notice("Usage: /skills list · /skills add <git-url> [branch] · /skills remove <id|url> · /skills update [id]")
        return
      }
      const normalized =
        action === "rm" ? "remove" : action === "ls" ? "list" : (action as "add" | "remove" | "update" | "list")
      const payload: { action: "add" | "remove" | "update" | "list"; url?: string; id?: string; branch?: string } = {
        action: normalized,
      }
      if (normalized === "add") {
        if (!parts[1]) {
          notice("Usage: /skills add <git-url> [branch]")
          return
        }
        payload.url = parts[1]
        if (parts[2]) payload.branch = parts[2]
      } else if (normalized === "remove") {
        if (!parts[1]) {
          notice("Usage: /skills remove <id|url>")
          return
        }
        payload.id = parts[1]
      } else if (normalized === "update" && parts[1]) {
        payload.id = parts[1]
      }
      const data = await manageSkillRepos(config.baseUrl, payload)
      if (normalized === "list") {
        // Per-skill on/off lines first (the human-facing catalog), then the
        // managed-repo summary.
        try {
          const skills = await getSkills(config.baseUrl, sessionId)
          if (skills.length > 0) {
            notice(
              skills
                .map((s) => `${s.enabled ? "on " : "off"} ${s.name} [${s.sourceLabel}]`)
                .join("  ·  "),
            )
          }
        } catch {
          /* the repo summary below is still useful */
        }
        const repos = (data.repos as Array<{ id: string; url: string; present: boolean; branch?: string; lastError?: string }>) ?? []
        if (repos.length === 0) {
          notice("No managed skill repos. `/skills add <git-url>` to install a pack.")
        } else {
          notice(
            repos
              .map(
                (r) =>
                  `${r.id}${r.present ? "" : " (missing)"}${r.branch ? ` @${r.branch}` : ""} — ${r.url}` +
                  (r.lastError ? ` · error: ${r.lastError}` : ""),
              )
              .join(" · "),
          )
        }
      } else if (normalized === "add") {
        const repo = data.repo as { id?: string } | undefined
        notice(`Skill repo added: ${repo?.id ?? "?"}. Skills appear in search_skills immediately.`)
      } else if (normalized === "remove") {
        notice(`Skill repo removed: ${data.id ?? payload.id}.`)
      } else {
        const failed = Number(data.failed ?? 0)
        notice(`Updated ${data.updated ?? 0} skill repo(s)${failed ? ` · ${failed} failed` : ""}.`)
      }
    },
    [config, notice, sessionId],
  )

  // Execute a KNOWN slash command (see lib/commands.ts) against the current
  // session. Anything the server does in response (goal.update markers, the
  // shipit brief-writing turn) streams back over the session's SSE.
  const runCommand = useCallback(
    async (name: string, rest: string) => {
      if (!config || !sessionId) return
      try {
        switch (name) {
          case "/clear":
            await handleNewThread()
            return
          case "/resume": {
            // Candidates: this repo's threads, minus the one we're on and
            // never-used empties (no events → lastActivity never moved past
            // creation). The list is newest-first, so [0] is "the last thread
            // I was in" — bare /resume is an alt-tab back to it.
            const list = await refreshSessions(config.baseUrl)
            const candidates = list.filter((s) => s.sessionId !== sessionId && s.lastActivity > s.createdAt)
            if (candidates.length === 0) {
              notice("No other threads in this repo yet.")
              return
            }
            const q = rest.toLowerCase()
            const match = q ? candidates.find((s) => s.title.toLowerCase().includes(q)) : candidates[0]!
            if (!match) {
              const recent = candidates.slice(0, 5).map((s) => `“${s.title}”`).join(", ")
              notice(`No thread title matches "${rest}". Recent: ${recent}`)
              return
            }
            void attachSession(config.baseUrl, match.sessionId, true)
            return
          }
          case "/shipit":
            await shipSession(config.baseUrl, sessionId, rest || undefined)
            notice(
              "Shipping — this thread is writing the handoff brief and will spawn a fresh goal-orchestrator thread (ship_goal). It appears in the sidebar once created.",
            )
            return
          case "/goal": {
            const intent = parseGoalArgs(rest)
            if (intent.kind === "status") {
              const goal = await fetchGoal(config.baseUrl, sessionId)
              if (!goal) {
                notice(
                  "No goal set. `/goal <objective>` starts one (autonomous until done); `--workflows` runs it as a workflow-orchestrator; `--turns 30` sets a budget; `/goal pause|resume|clear` manages it.",
                )
                return
              }
              const modeTag = goal.mode === "workflows" ? ", orchestrator" : ""
              notice(`Goal (${goal.status}${modeTag}, turn ${goal.turns}/${goal.maxTurns}): ${goal.objective}`)
              return
            }
            if (intent.kind === "action") {
              await postGoal(config.baseUrl, sessionId, { action: intent.action })
              return // the server streams a goal.update marker
            }
            await postGoal(config.baseUrl, sessionId, {
              objective: intent.objective,
              ...(intent.maxTurns ? { maxTurns: intent.maxTurns } : {}),
              ...(intent.mode ? { mode: intent.mode } : {}),
            })
            return // ditto — "◎ Goal set" arrives over SSE
          }
          case "/model":
            // Same affordance as the composer's model button — just open it.
            setModelOpenSignal((n) => n + 1)
            return
          case "/skills":
            await doSkills(rest)
            return
          case "/advisor":
            setAdvisorOpenSignal((n) => n + 1)
            return
          case "/login":
            await doLogin(rest)
            return
          case "/onboard":
            setOnboardingOpen(true)
            return
          case "/theme": {
            // Bare /theme cycles (same as clicking the TopNav toggle); an explicit
            // argument sets it outright.
            const arg = rest.trim().toLowerCase()
            if (!arg) {
              const next = cycleTheme()
              notice(
                next === "system"
                  // systemTheme() is read live rather than from render state, which
                  // still holds the pre-cycle value at this point.
                  ? `Appearance: matching your system (currently ${systemTheme()}). \`/theme light|dark\` pins it.`
                  : `Appearance: ${next}. \`/theme system\` follows your OS again.`,
              )
              return
            }
            if (!isThemeMode(arg)) {
              notice(`Usage: /theme <${THEME_MODES.join("|")}> — bare \`/theme\` cycles through them.`)
              return
            }
            setThemeMode(arg)
            notice(
              arg === "system"
                ? `Appearance: matching your system (currently ${systemTheme()}).`
                : `Appearance: ${arg}.`,
            )
            return
          }
          case "/cacheguard":
            await doCacheGuard(rest)
            return
          case "/mode":
            await doMode(rest)
            return
          case "/help":
            notice(
              "Commands: /clear, /resume, /help, /login, /model, /skills, /advisor, /mode, /goal, /shipit, /cacheguard. `/skills add <git-url>` installs a skill pack; `/skills list|remove|update` manages them. `/resume [title]` reopens a previous thread. `/goal <objective>` works autonomously until done (`--workflows` orchestrates). `/shipit [notes]` hands this plan to a fresh orchestrator. `/mode <name>` switches a saved pairing. `/cacheguard <tokens|off>` sets cold-cache confirm. Paste an image to attach it.",
            )
            return
        }
      } catch (err) {
        notice(`${name} failed: ${(err as Error).message}`)
      }
    },
    [
      config,
      sessionId,
      handleNewThread,
      notice,
      refreshSessions,
      attachSession,
      doLogin,
      doCacheGuard,
      doMode,
      doSkills,
      cycleTheme,
      setThemeMode,
    ],
  )

  const handleSubmit = useCallback(
    async (text: string, opts?: { interject?: boolean }) => {
      const trimmed = text.trim()
      if (!trimmed || !config || !sessionId) return
      setDraft("")
      // Known slash commands run against the server's control routes instead of
      // being sent as chat; unknown `/foo` text still goes to the model.
      const cmd = parseSlashCommand(trimmed)
      if (cmd) {
        await runCommand(cmd.name, cmd.rest)
        return
      }
      // A bare "/<name>" with no args may be a saved mode used as a direct slash
      // command (e.g. /fire applies the "fire" mode). Builtins were already
      // intercepted above and always win; match the remaining single-token slash
      // text against saved modes case-insensitively. Non-matches (including
      // unknown /foo) fall through to the model, as before.
      if (/^\/\S+$/.test(trimmed)) {
        const token = trimmed.slice(1).toLowerCase()
        const isBuiltin = SLASH_COMMANDS.some((c) => c.name.toLowerCase() === `/${token}`)
        if (!isBuiltin) {
          const mode = modesRef.current.find((m) => m.name.toLowerCase() === token)
          if (mode) {
            await doMode(mode.name)
            return
          }
        }
      }
      // The server echoes the user turn back over SSE (message.user), so we
      // don't optimistically insert it here — that keeps a single source of
      // truth and means resumed threads show past prompts too.
      const images = attachmentsRef.current
      const skill = pendingSkillRef.current
      setAttachments([]) // consume the pasted images with this message
      setPendingSkill(null) // the queued skill is applied to this turn only
      // Hand the whole message back to the composer — text, pasted images and
      // the queued skill — whenever the turn did NOT run.
      const restoreDraft = () => {
        setDraft(text)
        setAttachments(images)
        setPendingSkill(skill)
      }
      // How the server should handle this send. Option+Enter mid-turn asks to cut
      // in at the next main-thread tool boundary; a plain send while a turn runs
      // queues behind it (which is also what the server does for "auto" — being
      // explicit keeps the intent legible on the wire).
      const delivery: MessageDelivery = opts?.interject
        ? "interject"
        : runningRef.current
          ? "queue"
          : "auto"
      try {
        const blocked = await sendMessage(config.baseUrl, sessionId, trimmed, {
          images,
          skill,
          delivery,
        })
        if (blocked) {
          // Cache guard: the send did NOT run. Confirm before re-sending the
          // whole context, or hand the draft (and its images) back untouched.
          const w = blocked.warning
          const why =
            w.reason === "model-switch"
              ? "a model switch"
              : `~${Math.round((w.idleMs ?? 0) / 60_000)}m idle`
          const ok = await askConfirm({
            title: "Prompt cache went cold",
            body: `The cache went cold after ${why} — sending this will re-send ~${w.approxTokens.toLocaleString()} tokens. Send anyway?`,
            confirmLabel: "Send anyway",
          })
          if (!ok) {
            restoreDraft()
            return
          }
          await sendMessage(config.baseUrl, sessionId, trimmed, {
            images,
            skill,
            delivery,
            force: true,
          })
        }
        setCacheCold(null)
        void refreshSessions(config.baseUrl)
      } catch (err) {
        // The send failed, so the turn never ran: give the draft back instead of
        // eating it. Losing a long prompt to a dropped server is unforgivable.
        // A full queue is expected back-pressure, not a fault — say so plainly.
        restoreDraft()
        setConnError(
          err instanceof QueueFullError
            ? err.message
            : `Couldn't send that message: ${(err as Error).message}`,
        )
      }
    },
    [askConfirm, config, doMode, refreshSessions, runCommand, sessionId],
  )

  const handleStop = useCallback(() => {
    if (!config || !sessionId) return
    void interruptSession(config.baseUrl, sessionId)
  }, [config, sessionId])

  const activeRepo = repos.find((r) => r.id === activeRepoId) ?? null
  const workspaceName = activeRepo?.name || config?.workspaceName || "chunky"
  const groups = groupSessions(sessions)

  return (
    // Provides openInBrowser() to the transcript's markdown links, which sit too
    // deep (App → WorkspacePanes → ChatPane → TranscriptView) to thread another
    // prop through.
    <BrowserProvider openInBrowser={browser.openInBrowser}>
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
            endContent={
              <>
                <button
                  type="button"
                  className={`chunky-browser-toggle${browser.open ? " chunky-browser-toggle-on" : ""}`}
                  onClick={browser.toggle}
                  aria-pressed={browser.open}
                  aria-label={browser.open ? "Hide browser" : "Show browser"}
                  title={browser.open ? "Hide browser" : "Show browser"}
                >
                  <GlobeAltIcon />
                </button>
                <ThemeToggle />
              </>
            }
            startContent={
              <RepoTabs
                repos={repos}
                activeId={activeRepoId}
                onSelect={(id) => void handleSelectRepo(id)}
                onAdd={handleAddRepo}
                onRemove={(id) => void handleRemoveRepo(id)}
                agentsMdEnabled={agentsMdEnabled}
                onToggleAgentsMd={toggleAgentsMd}
                busy={addingRepo}
              />
            }
          />
        }
        sideNav={
          <SideNav
            collapsible
            // Codex-style anchored actions: "New thread" lives in the SideNav's
            // pinned `topContent` zone, so it stays put while only the thread
            // groups below scroll. This keeps the scrollbar short and makes it
            // start *below* this row instead of running the full sidebar height
            // right next to the chat pane's rounded top corner.
            topContent={
              <SideNavSection title="Quick actions" isHeaderHidden>
                <SideNavItem
                  label="New thread"
                  icon={PlusIcon}
                  onClick={() => void handleNewThread()}
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
                  {group.sessions.map((s) =>
                    s.sessionId === renamingId ? (
                      <ThreadRenameInput
                        key={s.sessionId}
                        // Placeholder titles start from an empty box — nobody wants
                        // to delete "New session" before typing their own name.
                        initial={isPlaceholderTitle(s.title) ? "" : s.title}
                        onCommit={(next) => void commitRename(s.sessionId, next)}
                        onCancel={() => setRenamingId(null)}
                      />
                    ) : (
                      // Rename lives on a `display: contents` wrapper, NOT inside
                      // the row. SideNavItem renders a <button> and puts
                      // endContent INSIDE it, so a pencil button there would nest
                      // interactive content — the mouse-only trap this codebase
                      // already hit once. The wrapper adds no box of its own, and
                      // dblclick/F2 bubble up from the row's own button.
                      <div
                        key={s.sessionId}
                        className="chunky-thread-row"
                        onDoubleClick={() => setRenamingId(s.sessionId)}
                        onKeyDown={(e) => {
                          // F2 is the platform-standard rename key (Finder, VS
                          // Code, Explorer) and works on the natively-focusable
                          // row button — no extra tab stop needed.
                          if (e.key === "F2") {
                            e.preventDefault()
                            setRenamingId(s.sessionId)
                          }
                        }}
                      >
                        <SideNavItem
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
                      </div>
                    ),
                  )}
                </SideNavSection>
              ))
            )}
          </SideNav>
        }
      >
        {/* onClose is the ONLY place onboarding is marked complete — the wizard's
            own Finish button routes through it too, so it can't double-post. */}
        {onboardingOpen && config && <OnboardingWizard baseUrl={config.baseUrl} onClose={() => { setOnboardingOpen(false); void completeOnboarding(config.baseUrl).catch(() => {}) }} onApplied={() => { void fetchModel(config.baseUrl).then(setModel); void fetchAdvisor(config.baseUrl).then(setAdvisorState) }} />}
        {confirmPrompt ? (
          <ConfirmModal
            title={confirmPrompt.title}
            body={confirmPrompt.body}
            confirmLabel={confirmPrompt.confirmLabel}
            onConfirm={() => confirmPrompt.resolve(true)}
            onCancel={() => confirmPrompt.resolve(false)}
          />
        ) : null}
        {loginWait ? (
          <WaitModal
            title={`Signing in to ${loginWait}`}
            body="Finish the sign-in in your browser — this window updates on its own once it lands."
            cancelLabel="Stop waiting"
            onCancel={() => loginAbort.current?.abort()}
          />
        ) : null}
        {connError ? (
          <div className="chunky-conn-error" role="alert">
            <div className="chunky-conn-error-row">
              <span className="chunky-conn-error-text">{connError}</span>
              <button
                type="button"
                className="chunky-conn-error-btn"
                onClick={() => void handleRetry()}
              >
                Retry
              </button>
              <button
                type="button"
                className="chunky-conn-error-close"
                aria-label="Dismiss this error"
                title="Dismiss"
                onClick={() => setConnError(null)}
              >
                ×
              </button>
            </div>
          </div>
        ) : null}
        {/* Workspace left (chat + terminal tabs), browser right. The browser
            docks beside whichever pane is active rather than only the chat, so
            you can read docs next to a terminal too. With the pane closed this
            is a plain full-width wrapper. */}
        <div className="chunky-split">
        <WorkspacePanes repoPath={activeRepo?.path}>
        <ChatPane
          state={transcript}
          workspaceName={workspaceName}
          baseUrl={config?.baseUrl}
          repoId={activeRepoId}
          model={model}
          onModelChange={setModel}
          modes={modes}
          onRefreshModes={refreshModes}
          advisor={advisor}
          onAdvisorChange={setAdvisorState}
          goal={goal}
          todos={todos}
          cacheCold={cacheCold}
          runningSince={runningSince}
          attachmentCount={attachments.length}
          // The images themselves, for the composer's thumbnail strip. App owns
          // this state (handleSubmit consumes it via attachmentsRef and hands it
          // back on a failed send), so ChatPane stays a pure presenter.
          attachments={attachments}
          onAttachImage={(img) => setAttachments((a) => [...a, img])}
          // Drop ONE image by position. Rebuilds the array rather than mutating:
          // a send in flight captured the previous array by reference, and must
          // keep the exact set it posted for restore-on-failure.
          onRemoveAttachment={(index) =>
            setAttachments((a) => a.filter((_, i) => i !== index))
          }
          onClearAttachments={() => setAttachments([])}
          sessionId={sessionId}
          pendingSkill={pendingSkill}
          onClearSkill={() => setPendingSkill(null)}
          onSelectSkill={(name) => setPendingSkill(name)}
          modelOpenSignal={modelOpenSignal}
          advisorOpenSignal={advisorOpenSignal}
          skillsOpenSignal={skillsOpenSignal}
          transcriptLoading={transcriptLoading}
          draft={draft}
          onDraftChange={setDraft}
          // Option+Enter mid-turn arrives here as { interject: true }.
          onSubmit={(t: string, opts?: { interject?: boolean }) => void handleSubmit(t, opts)}
          onStop={handleStop}
          // Server-authoritative queue depth (queue.changed) — the bodies live on
          // the server; this only reports how many are pending.
          queueCount={transcript.queue.entries.length}
          // Drives the composer's "reconnecting…" pill. Deliberately separate from
          // connError: an active reconnect resolves itself, so it isn't something
          // the user can dismiss.
          connectionState={connectionState}
          // Suggestion chips PREFILL the composer rather than firing the canned
          // string at the model as a real turn — they're a starting point to edit,
          // not a prompt anyone meant to send verbatim. Focus follows the text in,
          // so it lands ready to type rather than needing a click.
          onSuggestion={(t) => {
            setDraft(t)
            setComposerFocusSignal((n) => n + 1)
          }}
          focusSignal={composerFocusSignal}
        />
        </WorkspacePanes>
        <BrowserPane
          open={browser.open}
          request={browser.request}
          width={browser.width}
          // A native overlay can outrank HTML for a frame or two while masks
          // resync, so full-screen modals hide the webview outright rather than
          // relying on the punch-through alone.
          suppressed={onboardingOpen || confirmPrompt !== null || loginWait !== null}
          onWidthChange={browser.setWidth}
          onClose={browser.close}
          onNavigate={browser.rememberUrl}
        />
        </div>
      </AppShell>
    </div>
    </BrowserProvider>
  )
}
