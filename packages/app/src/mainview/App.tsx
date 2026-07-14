import { useCallback, useEffect, useRef, useState } from "react"
import type { CacheCold, GoalSnapshot, ModeSpec, SessionSummary } from "@chunky/protocol"
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
  applyMode,
  createSession,
  deleteMode,
  fetchAdvisor,
  fetchCacheGuard,
  fetchCacheStatus,
  fetchGoal,
  fetchModel,
  fetchModes,
  initiateLogin,
  interruptSession,
  listProviders,
  listRepos,
  listSessions,
  loadConfig,
  loginStatus,
  fetchOnboarding,
  getSkills,
  manageSkillRepos,
  openEventStream,
  postGoal,
  prettyModel,
  removeRepo,
  saveMode,
  sendMessage,
  setCacheGuard,
  shipSession,
  type AdvisorState,
  type AppConfig,
  type InputImage,
  type ModelSelection,
  type Repo,
} from "./lib/api"
import { openExternal } from "./lib/rpc"
import { parseGoalArgs, parseSlashCommand } from "./lib/commands"
import { fmtTokens } from "./lib/format"
import { OnboardingWizard } from "./components/OnboardingWizard"

// Which repo tab is open is THIS CLIENT's UI state (the server has no global
// active workspace anymore) — remembered locally so a relaunch restores it.
const ACTIVE_REPO_KEY = "chunky.activeRepoId"
import { groupSessions, relativeTime, threadLabel } from "./lib/format"
import { MIN_NOTIFY_MS, notifyTurnEnd } from "./lib/notify"
import { initialState, pushNotice, reduce, type TranscriptState } from "./lib/transcript"

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
  // The always-on advisor config (composer trigger label + /advisor).
  const [advisor, setAdvisorState] = useState<AdvisorState | null>(null)
  // The session's current goal (composer pill; tracked from goal.update events).
  const [goal, setGoal] = useState<GoalSnapshot | null>(null)
  // Passive cold-cache indicator: while idle, the NEXT send would re-send this
  // much context. Shown above the composer so the warning lands BEFORE you send.
  const [cacheCold, setCacheCold] = useState<CacheCold | null>(null)
  // Images pasted onto the NEXT message. A ref mirrors it so handleSubmit reads
  // the latest set without going stale in its closure.
  const [attachments, setAttachments] = useState<InputImage[]>([])
  const attachmentsRef = useRef<InputImage[]>([])
  attachmentsRef.current = attachments
  // Wall-clock start of the in-flight turn (drives the elapsed-seconds pill).
  const [runningSince, setRunningSince] = useState<number | null>(null)
  // Bumped by /model and /advisor to open the corresponding composer menu.
  const [modelOpenSignal, setModelOpenSignal] = useState(0)
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

  const sessionIdRef = useRef<string | null>(null)
  const streamAbort = useRef<AbortController | null>(null)
  const activeRepoIdRef = useRef<string | null>(null)
  sessionIdRef.current = sessionId
  activeRepoIdRef.current = activeRepoId

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
      // Per-session UI state must not leak across threads. goal.update events
      // replay over SSE, but a session with no goal never emits one — so seed
      // from the REST snapshot rather than trusting replay alone.
      setGoal(null)
      setCacheCold(null)
      setAttachments([])
      setPendingSkill(null)
      void fetchGoal(baseUrl, id).then(setGoal).catch(() => {})

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

  // Client-local status line for slash-command feedback (never persisted —
  // the server's own goal.update/message events remain the durable record).
  const notice = useCallback((text: string) => {
    setTranscript((s) => pushNotice(s, text))
  }, [])

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
        const deadline = Date.now() + 150_000
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 2000))
          if (await loginStatus(config.baseUrl, p.id)) {
            notice(`✓ Logged in to ${p.id}. Pick one of its models with /model.`)
            return
          }
        }
        notice(`Still waiting on ${p.id} login. Finish in the browser, then pick a model with /model.`)
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
      notice(`Mode "${body.applied}" applied: ${prettyModel(body.model)}${effortParen(body.effort)} · ${body.provider}.`)
    },
    [config, notice],
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
    [config, sessionId, handleNewThread, notice, refreshSessions, attachSession, doLogin, doCacheGuard, doMode, doSkills],
  )

  const handleSubmit = useCallback(
    async (text: string) => {
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
      // The server echoes the user turn back over SSE (message.user), so we
      // don't optimistically insert it here — that keeps a single source of
      // truth and means resumed threads show past prompts too.
      const images = attachmentsRef.current
      const skill = pendingSkillRef.current
      setAttachments([]) // consume the pasted images with this message
      setPendingSkill(null) // the queued skill is applied to this turn only
      try {
        const blocked = await sendMessage(config.baseUrl, sessionId, trimmed, { images, skill })
        if (blocked) {
          // Cache guard: the send did NOT run. Confirm before re-sending the
          // whole context, or hand the draft (and its images) back untouched.
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
            setAttachments(images)
            setPendingSkill(skill)
            return
          }
          await sendMessage(config.baseUrl, sessionId, trimmed, { images, skill, force: true })
        }
        setCacheCold(null)
        void refreshSessions(config.baseUrl)
      } catch (err) {
        setConnError((err as Error).message)
      }
    },
    [config, refreshSessions, runCommand, sessionId],
  )

  const handleStop = useCallback(() => {
    if (!config || !sessionId) return
    void interruptSession(config.baseUrl, sessionId)
  }, [config, sessionId])

  const activeRepo = repos.find((r) => r.id === activeRepoId) ?? null
  const workspaceName = activeRepo?.name || config?.workspaceName || "chunky"
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
        {onboardingOpen && config && <OnboardingWizard baseUrl={config.baseUrl} onClose={() => setOnboardingOpen(false)} onApplied={() => { void fetchModel(config.baseUrl).then(setModel); void fetchAdvisor(config.baseUrl).then(setAdvisorState) }} />}
        {connError ? <div className="chunky-conn-error">{connError}</div> : null}
        <ChatPane
          state={transcript}
          workspaceName={workspaceName}
          baseUrl={config?.baseUrl}
          repoId={activeRepoId}
          model={model}
          onModelChange={setModel}
          advisor={advisor}
          onAdvisorChange={setAdvisorState}
          goal={goal}
          cacheCold={cacheCold}
          runningSince={runningSince}
          attachmentCount={attachments.length}
          onAttachImage={(img) => setAttachments((a) => [...a, img])}
          onClearAttachments={() => setAttachments([])}
          sessionId={sessionId}
          pendingSkill={pendingSkill}
          onClearSkill={() => setPendingSkill(null)}
          onSelectSkill={(name) => setPendingSkill(name)}
          modelOpenSignal={modelOpenSignal}
          advisorOpenSignal={advisorOpenSignal}
          skillsOpenSignal={skillsOpenSignal}
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
