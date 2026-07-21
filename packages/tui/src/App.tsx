import { useCallback, useEffect, useRef, useState } from "react"
import { realpathSync } from "node:fs"
import { TextAttributes } from "@opentui/core"
import { useRenderer } from "@opentui/react"
import { rawModeSupported, useInput } from "./useInput.js"
import {
  ROUTES,
  readSSE,
  type AgentEvent,
  type CacheCold,
  type CacheGuardResponse,
  type CacheStatusResponse,
  type CreateSessionResponse,
  type ServerInfoResponse,
  type GoalRequest,
  type GoalSnapshot,
  type GoalStateResponse,
  type ForkResponse,
  type ListSessionsResponse,
  type LoginInitiation,
  type RewindPoint,
  type RewindPointsResponse,
  type ModeSpec,
  type ModesResponse,
  type SendBlockedResponse,
  type SessionSummary,
} from "@chunky/protocol"
import { mockRun } from "@chunky/protocol/mock"
import { mockThreadsRun } from "./mockThreads.js"
import { initialState, pushUser, reduce, type TranscriptState } from "./transcript.js"
import { abortableSleep, isIntentionalAbort, reconnectDelay, retryableHttpMessage } from "./reconnect.js"
import { ACCENT, BORDER, setIncognitoTheme, WARNING } from "./theme.js"
import { WelcomeBanner } from "./components/WelcomeBanner.js"
import { Transcript, fmtTokens } from "./components/Transcript.js"
import { incognitoSegment, StatusLine, WatchingLine } from "./components/StatusLine.js"
import { PromptInput, type StatusSegment } from "./components/PromptInput.js"
import { LoginPicker, type ProviderRow } from "./components/LoginPicker.js"
import { ResumePicker } from "./components/ResumePicker.js"
import { RewindPicker } from "./components/RewindPicker.js"
import { ForkPicker, parseForkArgs } from "./components/ForkPicker.js"
import { ModelPicker, type ModelSelectionResult } from "./components/ModelPicker.js"
import { SkillsPicker } from "./components/SkillsPicker.js"
import { ProviderPicker } from "./components/ProviderPicker.js"
import { OnboardingWizard } from "./components/OnboardingWizard.js"
import { AdvisorPicker, type AdvisorSelectionResult } from "./components/AdvisorPicker.js"
import { SidekickSeatMenu } from "./components/SidekickSeatMenu.js"
import { ModeMenu, type ModeApplyPayload } from "./components/ModeMenu.js"
import {
  incognitoAppliedLine,
  NO_INCOGNITO_MODES,
  notIncognitoLine,
  resolveIncognitoCommand,
  unknownModeLine,
  type SavedMode,
} from "./incognitoModes.js"
import { COMMANDS, builtinCommandNames, savedModeForCommand, type Command } from "./components/SlashMenu.js"
import {
  renderScoreboard,
  renderUsage,
  usageTotalsLine,
  type ScoreboardResponse,
  type UsageResponse,
} from "./stats.js"
import { openBrowser } from "./openBrowser.js"
import { grabClipboardImage, type ClipboardImage } from "./clipboardImage.js"
import { writeClipboard } from "./clipboard.js"
import { ToastContext, ToastOverlay, useToastController } from "./components/Toast.js"
import { MIN_NOTIFY_MS, notifyTurnEnd, notifyTurnStart, resetTerminalTitle } from "./notify.js"

interface Props {
  mode: "mock" | "live"
  baseUrl: string
  cwd: string
  /** In mock mode, auto-run one demo turn on mount (lets the UI stream with no TTY). */
  autoDemo?: boolean
  /** Which mock generator the auto-demo drives ("threads" shows the nested-thread view). */
  demo?: "basic" | "threads"
}

/** Is this (existing) session off the record? Read from the session list, which
 *  carries the server-owned flag. Advisory: any failure — old server, no field,
 *  unreachable — reads as a normal session rather than throwing at attach time. */
async function fetchIncognito(baseUrl: string, sessionId: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl + ROUTES.listSessions}?cwd=${encodeURIComponent(process.cwd())}`)
    if (!res.ok) return false
    const body = (await res.json()) as ListSessionsResponse
    return body.sessions.find((s) => s.sessionId === sessionId)?.incognito === true
  } catch {
    return false
  }
}

// Model ids that read better fully uppercased in the status line.
const MODEL_ACRONYMS = new Set(["glm", "gpt", "api", "llm"])

/** Prettify a model id for display: `grok-4.5` → `Grok 4.5`, `glm-5.2` → `GLM 5.2`,
 *  `claude-fable-5` → `Claude Fable 5`. Strips any `[...]` variant tag. Best-effort. */
function prettyModel(id: string | null | undefined): string {
  if (!id) return "…"
  return id
    .replace(/\[.*?\]/g, "")
    .split(/[-_]/)
    .filter(Boolean)
    .map((p) => (MODEL_ACRONYMS.has(p.toLowerCase()) ? p.toUpperCase() : /^[\d.]+$/.test(p) ? p : p[0]!.toUpperCase() + p.slice(1)))
    .join(" ")
}

/** The active model selection, shown on the status line and updated by /model. */
interface CurrentSelection {
  provider: string
  model: string | null
  effort?: string | null
  speed?: string | null
}

/** Short human phrase for WHY the cache is cold: "42m idle" / "model switch". */
function coldReason(w: CacheCold): string {
  if (w.reason === "model-switch") {
    const models = w.fromModel && w.toModel ? ` (${w.fromModel} → ${w.toModel})` : ""
    return `model switch${models}`
  }
  const mins = w.idleMs != null ? Math.round(w.idleMs / 60_000) : 0
  return `${mins}m idle`
}

/** A send the server refused via the cache guard, parked until the user decides. */
interface PendingSend {
  text: string
  shown: string
  images: ClipboardImage[]
  warning: CacheCold
  guardTokens: number
}

export function App({ mode, baseUrl, cwd, autoDemo = true, demo = "basic" }: Props) {
  const [updateNotice, setUpdateNotice] = useState<string | null>(null)
  useEffect(() => {
    if (mode !== "live") return
    void fetch(baseUrl + ROUTES.updateStatus).then((r) => r.json()).then((u: { latest?: string; available?: boolean }) => {
      if (u.available && u.latest) setUpdateNotice(`⬆ chunky v${u.latest} available — run: chunky update`)
    }).catch(() => {})
  }, [mode, baseUrl])
  const renderer = useRenderer()
  // Tear down the OpenTUI renderer (restores the terminal) and leave.
  const exit = useCallback(() => {
    resetTerminalTitle()
    renderer.destroy()
    process.exit(0)
  }, [renderer])
  useEffect(() => () => resetTerminalTitle(), [])

  // Ephemeral toast layer (the generalization of the old copy badge).
  const { toasts, api: toast } = useToastController()

  // Copy-on-select. OpenTUI holds the mouse (useMouse defaults on), so a drag
  // builds OUR selection, not a native terminal one — the emulator's ⌘C would
  // copy nothing. On drag end we copy it ourselves (OSC 52 + native tool) and pop
  // a toast anchored at the release point (where the cursor is), not off in a
  // corner where it's easy to miss.
  const copySelection = useCallback(
    (e?: { x: number; y: number }) => {
      const text = renderer.getSelection()?.getSelectedText() ?? ""
      if (!text) return // a plain click (no drag) selects nothing — ignore
      void writeClipboard(text)
      renderer.clearSelection()
      toast.show({
        message: `Copied ${text.length} char${text.length === 1 ? "" : "s"}`,
        variant: "success",
        at: {
          x: e?.x ?? Math.floor(renderer.terminalWidth / 2),
          y: e?.y ?? Math.floor(renderer.terminalHeight / 2),
        },
      })
    },
    [renderer, toast],
  )

  // The debug console overlay (opened on error) keeps its own selection; route
  // its copy through the same clipboard path + a corner toast.
  useEffect(() => {
    renderer.console.onCopySelection = (text: string) => {
      if (!text) return
      void writeClipboard(text)
      toast.show({ message: `Copied ${text.length} chars`, variant: "success" })
    }
    return () => {
      renderer.console.onCopySelection = undefined
    }
  }, [renderer, toast])
  const [state, setState] = useState<TranscriptState>(initialState)
  const [connection, setConnection] = useState<"connecting" | "connected" | "reconnecting">("connecting")
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [threadsCollapsed, setThreadsCollapsed] = useState(false)
  // When set, the /login provider picker is open; PromptInput is disabled and
  // arrow/enter/esc drive the picker instead.
  const [loginPicker, setLoginPicker] = useState<{ providers: ProviderRow[]; selected: number } | null>(null)
  // When true, the /model fuzzy picker is open (owns the keyboard while shown).
  const [modelPickerOpen, setModelPickerOpen] = useState(false)
  const [skillsPickerOpen, setSkillsPickerOpen] = useState(false)
  const [pendingSkill, setPendingSkill] = useState<string | null>(null)
  const [providerPickerOpen, setProviderPickerOpen] = useState(false)
  const [onboardingOpen, setOnboardingOpen] = useState(false)
  // When true, the /advisor picker is open (owns the keyboard while shown).
  const [advisorPickerOpen, setAdvisorPickerOpen] = useState(false)
  // When set, the /sidekick picker is open (owns the keyboard while shown).
  // `seat` targets a NAMED seat (e.g. "frontend"); undefined = the default seat.
  const [sidekickPicker, setSidekickPicker] = useState<{ seat?: string } | null>(null)
  const [sidekickSeatMenuOpen, setSidekickSeatMenuOpen] = useState(false)
  // When true, the interactive /mode menu is open (owns the keyboard while shown).
  const [modeMenuOpen, setModeMenuOpen] = useState(false)
  // Same menu, filtered to incognito modes: /incognito's "which one?" picker.
  const [incognitoMenuOpen, setIncognitoMenuOpen] = useState(false)
  const [slashModes, setSlashModes] = useState<Command[]>([])
  const doModeRef = useRef<(rest: string) => void>(() => {})
  // When set, the /resume thread picker is open (owns the keyboard while shown).
  const [resumePicker, setResumePicker] = useState<{ sessions: SessionSummary[]; selected: number } | null>(null)
  // When set, the /rewind picker is open. `error` shows a server refusal (409)
  // in place; `busy` freezes the keys while the POST is in flight.
  const [rewindPicker, setRewindPicker] = useState<{
    points: RewindPoint[]
    error?: string | null
    busy?: boolean
  } | null>(null)
  // When set, the /fork worktree chooser is open (only when no --worktree flag).
  const [forkPicker, setForkPicker] = useState<{
    directive?: string
    error?: string | null
    busy?: boolean
  } | null>(null)
  // The active model selection, reflected on the status line.
  const [currentSel, setCurrentSel] = useState<CurrentSelection | null>(null)
  // The active advisor config, reflected on the status line.
  const [advisor, setAdvisor] = useState<{
    enabled: boolean
    provider?: string
    model?: string
    effort?: string
    active: boolean
  } | null>(null)
  // The active sidekick config, reflected on the status line. No `active` flag:
  // an enabled seat with no model inherits the executor's selection. `seats` is
  // the named domain seats (e.g. frontend/backend).
  const [sidekick, setSidekick] = useState<{
    enabled: boolean
    provider?: string
    model?: string
    effort?: string
    seats: Record<string, { provider: string; model: string; effort?: string }>
  } | null>(null)
  // The session's current goal (drives the status line + goal transcript markers).
  const [goal, setGoal] = useState<GoalSnapshot | null>(null)
  // A send the cache guard blocked (409): held with its images until the user
  // confirms (enter → resend with force) or cancels (esc → text back in input).
  const [pendingSend, setPendingSend] = useState<PendingSend | null>(null)
  // Passive cold-cache indicator: while idle, the NEXT send would re-send this
  // much context. Shown above the input so the warning lands BEFORE you send.
  const [cacheCold, setCacheCold] = useState<CacheCold | null>(null)
  // Hands a canceled pending send's text back to the input (nonce = re-trigger).
  const [prefill, setPrefill] = useState<{ text: string; nonce: number } | null>(null)
  // Bumped by /clear so the live-session effect creates a brand-new server
  // session (fresh prompt cache + empty transcript) instead of only wiping UI.
  const [sessionKey, setSessionKey] = useState(0)
  // True while the ATTACHED session is off the record. Server-owned and fixed at
  // session creation, so it's read once per attach (create response, or the
  // session list when resuming) and never mutated locally.
  const [incognito, setIncognito] = useState(false)
  const sessionIdRef = useRef<string | null>(null)
  const workspaceWarningShownRef = useRef(false)
  // Set by /resume before bumping sessionKey: the live effect ATTACHES to this
  // existing session (SSE replays its history) instead of creating a new one.
  // /clear resets it so the next attach is a fresh session again.
  const resumeTargetRef = useRef<string | null>(null)
  // True from a resume-attach until the user's first send: from-less
  // message.user events (the user's own PAST sends, replayed from history)
  // render from the event. Cleared before each live send so the server's echo
  // can't double with the local pushUser echo (see reduce()'s message.user).
  const resumeReplayRef = useRef(false)
  // Set below once `attachSession`/`printLine` exist; lets the SSE reducer
  // (declared earlier than both) react to another client rewinding this session.
  const onRemoteRewindRef = useRef<(sessionId: string, turn: number) => void>(() => {})
  // Images pasted (Ctrl+V) onto the NEXT message. A ref mirrors it so `submit`
  // reads the latest set without going stale in its closure.
  const [attachments, setAttachments] = useState<ClipboardImage[]>([])
  const attachmentsRef = useRef<ClipboardImage[]>([])
  attachmentsRef.current = attachments

  // Server-authoritative count from queue.changed. The queued prompt bodies live
  // only on the server; this client never drains or re-sends them.
  const [authoritativeQueueCount, setAuthoritativeQueueCount] = useState(0)
  // Running background bash tasks + monitors, from background.changed. That
  // event is LIVE-ONLY (never replayed from history), so these counts are always
  // reset to 0 on a session switch and re-learned from the next live event.
  const [background, setBackground] = useState({ tasks: 0, monitors: 0 })
  // Latest run state for `submit`, which is defined before `running` is derived.
  const runningRef = useRef(false)
  runningRef.current = state.status === "running"

  const rawSupported = rawModeSupported

  const pickerOpen =
    loginPicker != null ||
    modelPickerOpen ||
    skillsPickerOpen ||
    providerPickerOpen ||
    advisorPickerOpen ||
    sidekickPicker != null ||
    sidekickSeatMenuOpen ||
    modeMenuOpen ||
    incognitoMenuOpen ||
    resumePicker != null ||
    rewindPicker != null ||
    forkPicker != null ||
    pendingSend != null

  // Ctrl+T collapses/expands child-thread bodies (the tree view stays; only
  // spawned threads' contents fold to their header lines).
  // Esc interrupts the in-flight turn (POST /interrupt aborts the run server-side).
  useInput(
    (input, key) => {
      if (pickerOpen) return // a picker owns the keys while open
      if (key.escape && pendingSkill) {
        setPendingSkill(null)
        return
      }
      if (key.ctrl && (input === "t" || input === "T")) setThreadsCollapsed((v) => !v)
      if (key.escape && mode === "live" && state.status === "running") {
        const sid = sessionIdRef.current
        if (sid) void fetch(baseUrl + ROUTES.interrupt(sid), { method: "POST" }).catch(() => {})
      }
    },
    { isActive: rawSupported },
  )

  // Turn-end desktop notification bookkeeping: when the run started (wall
  // clock — replay processes events in ms, so replayed turns never notify) and
  // the final assistant text of the turn (accumulated from main-thread deltas).
  const runningSinceRef = useRef<number | null>(null)
  const lastAssistantRef = useRef("")

  const apply = useCallback(
    (ev: AgentEvent) => {
      // Replayed OWN sends have no local pushUser echo — the persisted event is
      // their only appearance (reduce() skips from-less user events so live
      // sends don't double). Only rendered while a resume replay is streaming.
      if (ev.type === "message.user" && !ev.from && resumeReplayRef.current) {
        setState((s) => pushUser(s, ev.text))
        return
      }
      setState((s) => reduce(s, ev))
      if (ev.type === "message.start" && !ev.threadId) lastAssistantRef.current = ""
      if (ev.type === "message.delta" && !ev.threadId) lastAssistantRef.current += ev.text
      if (ev.type === "queue.changed") setAuthoritativeQueueCount(ev.entries.length)
      if (ev.type === "background.changed") setBackground({ tasks: ev.tasks, monitors: ev.monitors })
      // Live sends are echoed locally after the POST is accepted. On resume, the
      // accepted injected:false event is the sole raw transcript echo;
      // injected:true is only a model-continuation marker.
      if (ev.type === "message.interjection" && !ev.injected && resumeReplayRef.current) {
        setState((s) => pushUser(s, ev.text))
      }
      if (ev.type === "session.status") {
        setStartedAt(ev.status === "running" ? Date.now() : null)
        if (ev.status === "running") {
          if (mode === "live") notifyTurnStart()
          runningSinceRef.current = Date.now()
        } else {
          const since = runningSinceRef.current
          runningSinceRef.current = null
          if (mode === "live" && since != null && Date.now() - since >= MIN_NOTIFY_MS) {
            notifyTurnEnd(lastAssistantRef.current)
          }
        }
      }
      // Track goal state for the status line. History replay (resume) re-runs these
      // in order, so the last one wins and the status line reflects the true state.
      if (ev.type === "goal.update") setGoal(ev.goal)
      // Another client (or this one) rewound the session: the live stream is now
      // stale. Re-attach so the truncated history replays through the same path.
      if (ev.type === "session.rewound") onRemoteRewindRef.current(ev.sessionId, ev.turn)
    },
    [mode],
  )

  // Retint the whole UI for an off-the-record session and re-render so every
  // component re-reads the accent (theme.ts exports LIVE bindings, so nothing
  // else has to know). Also runs with `false` when attaching to a normal
  // session, which is what restores the lavender after leaving an incognito one.
  const applyIncognito = useCallback((on: boolean) => {
    setIncognitoTheme(on)
    setIncognito(on)
  }, [])

  // ---- live wiring: open the SSE stream BEFORE any message is sent ----
  // `sessionKey` re-runs this on /clear (fresh server session) and on /resume
  // (resumeTargetRef set → attach to that EXISTING session; the SSE history
  // replay rebuilds the transcript, so reattaching IS resuming).
  useEffect(() => {
    if (mode !== "live") return
    let cancelled = false
    const streamAbort = new AbortController()
    sessionIdRef.current = null
    ;(async () => {
      try {
        let sessionId = resumeTargetRef.current
        // The server owns the flag; older servers omit it, so anything but an
        // explicit `true` means a normal session.
        let sessionIncognito: boolean | null = null
        if (!sessionId) {
          const res = await fetch(baseUrl + ROUTES.createSession, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd: process.cwd() }) })
          const created = (await res.json()) as CreateSessionResponse & { incognito?: boolean }
          sessionId = created.sessionId
          sessionIncognito = created.incognito === true
        }
        if (cancelled) return
        if (!resumeTargetRef.current) {
          try {
            const info = (await (await fetch(baseUrl + ROUTES.serverInfo)).json()) as ServerInfoResponse
            const real = (() => { try { return realpathSync(process.cwd()) } catch { return process.cwd() } })()
            if (!workspaceWarningShownRef.current && info.workspace !== real) {
              workspaceWarningShownRef.current = true
              printLine(`Connected to server for ${info.workspace} — sessions here belong to that worktree; launch via chunky in this directory for an isolated server`)
            }
          } catch { /* handshake is advisory */ }
        }
        sessionIdRef.current = sessionId
        // Resuming an existing session: the create response never happened, so
        // the flag comes off the session list instead. Advisory — a failure just
        // leaves the normal palette.
        if (sessionIncognito == null) sessionIncognito = await fetchIncognito(baseUrl, sessionId)
        if (cancelled) return
        applyIncognito(sessionIncognito)
        // Only a resumed thread has history: render its replayed user turns.
        resumeReplayRef.current = resumeTargetRef.current != null
        // New conversation: nothing tracked yet, so the cold banner must go.
        setCacheCold(null)
        let attempt = 0
        while (!cancelled) {
          try {
            setConnection(attempt ? "reconnecting" : "connecting")
            const evRes = await fetch(baseUrl + ROUTES.events(sessionId), { signal: streamAbort.signal })
            if (!evRes.ok) throw new Error(retryableHttpMessage(evRes.status))
            // /events always begins with the complete history. Reset the
            // projection before consuming it so replay never duplicates rows.
            setState(initialState)
            resumeReplayRef.current = true
            setConnection("connected")
            for await (const ev of readSSE(evRes)) {
              if (cancelled) break
              apply(ev)
              // A successful replay or live event proves the attachment is
              // healthy; the next independent failure starts at base delay.
              attempt = 0
            }
            if (cancelled) break
            setConnection("reconnecting")
            attempt = 1
            // EOF is a disconnect even when the server closed cleanly.
            await abortableSleep(reconnectDelay(attempt - 1), streamAbort.signal)
          } catch (err) {
            if (isIntentionalAbort(err, streamAbort.signal, cancelled)) break
            attempt++
            setConnection("reconnecting")
            await abortableSleep(reconnectDelay(attempt), streamAbort.signal)
          }
        }
      } catch (err) {
        if (!isIntentionalAbort(err, streamAbort.signal, cancelled)) setConnection("reconnecting")
      }
    })()
    return () => {
      cancelled = true
      streamAbort.abort()
      setConnection("connecting")
    }
  }, [mode, baseUrl, apply, sessionKey, applyIncognito])

  // ---- live: load the current model selection so the status line is accurate ----
  useEffect(() => {
    if (mode !== "live") return
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(baseUrl + "/api/model")
        const body = (await res.json()) as CurrentSelection
        if (!cancelled) setCurrentSel(body)
      } catch {
        // leave as null; status line falls back to a placeholder
      }
    })()
    return () => {
      cancelled = true
    }
  }, [mode, baseUrl])

  // ---- live: load the advisor config so the status line shows it (and after /advisor) ----
  const refreshAdvisor = useCallback(async () => {
    if (mode !== "live") return
    try {
      const res = await fetch(baseUrl + "/api/advisor")
      const body = (await res.json()) as {
        config?: { enabled?: boolean; provider?: string; model?: string; effort?: string }
        active?: boolean
      }
      setAdvisor({
        enabled: body.config?.enabled ?? false,
        provider: body.config?.provider,
        model: body.config?.model,
        effort: body.config?.effort,
        active: Boolean(body.active),
      })
    } catch {
      // leave as null; status line omits the advisor label
    }
  }, [mode, baseUrl])

  // ---- live: load the sidekick config so the status line shows it (and after /sidekick) ----
  const refreshSidekick = useCallback(async () => {
    if (mode !== "live") return
    try {
      const res = await fetch(baseUrl + "/api/sidekick")
      const body = (await res.json()) as {
        config?: { enabled?: boolean; provider?: string; model?: string; effort?: string }
        seats?: Record<string, { provider: string; model: string; effort?: string }>
      }
      setSidekick({
        enabled: body.config?.enabled ?? false,
        provider: body.config?.provider,
        model: body.config?.model,
        effort: body.config?.effort,
        seats: body.seats ?? {},
      })
    } catch {
      // leave as null; status line omits the sidekick label
    }
  }, [mode, baseUrl])

  useEffect(() => {
    void refreshAdvisor()
    void refreshSidekick()
  }, [refreshAdvisor, refreshSidekick])

  // POST one user message to the live server. On a cache-guard 409 the send is
  // parked in pendingSend (nothing ran server-side); otherwise echo the user
  // line locally and start the turn timer.
  const postMessage = useCallback(
    async (text: string, shown: string, images: ClipboardImage[], force: boolean, steer = false, skill?: string | null, delivery?: "interject" | "queue") => {
      const id = sessionIdRef.current
      if (!id) {
        apply({ type: "error", message: "no live session yet" })
        return
      }
      // End any resume-replay window BEFORE the request leaves: from here the
      // local pushUser below is the echo, so the server's from-less message.user
      // for this send must not render too.
      resumeReplayRef.current = false
      try {
        const res = await fetch(baseUrl + ROUTES.sendMessage(id), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            text,
            ...(images.length ? { images } : {}),
            ...(force ? { force: true } : {}),
            ...(steer ? { steer: true } : {}),
            ...(delivery ? { delivery } : {}),
            ...(skill ? { skill } : {}),
          }),
        })
        if (res.status === 409) {
          const body = (await res.json()) as SendBlockedResponse
          setPendingSend({ text, shown, images, warning: body.warning, guardTokens: body.guardTokens })
          return
        }
        setState((s) => pushUser(s, shown))
        setStartedAt(Date.now())
        setCacheCold(null)
      } catch (err) {
        apply({ type: "error", message: `send failed: ${String(err)}` })
      }
    },
    [baseUrl, apply, slashModes],
  )

  const submit = useCallback(
    async (text: string, display?: string, opts?: { delivery?: "interject" | "steer" }) => {
      // `text` is the full message (paste chips expanded) sent to the model;
      // `display` is the shortened echo (chips kept) shown in the transcript.
      // Slash commands that take arguments arrive here (the menu only fires bare
      // commands via onCommand): `/goal <objective>`, `/cacheguard <tokens|off>`.
      const command = text.trim()
      if (/^\/[^/\s]+$/.test(command)) {
        const modeName = savedModeForCommand(command, slashModes)
        if (modeName) {
          doModeRef.current(modeName)
          return
        }
      }
      if (command === "/goal" || command.startsWith("/goal ")) {
        void doGoal(command.slice("/goal".length).trim())
        return
      }
      if (command === "/shipit" || command.startsWith("/shipit ")) {
        void doShipIt(command.slice("/shipit".length).trim())
        return
      }
      if (command === "/cacheguard" || command.startsWith("/cacheguard ")) {
        void doCacheGuard(command.slice("/cacheguard".length).trim())
        return
      }
      if (command === "/mode" || command.startsWith("/mode ")) {
        void doMode(command.slice("/mode".length).trim())
        return
      }
      if (command === "/incognito" || command.startsWith("/incognito ")) {
        void doIncognito(command.slice("/incognito".length).trim())
        return
      }
      if (command === "/model" || command.startsWith("/model ")) {
        void doModelCatalog(command.slice("/model".length).trim())
        return
      }
      if (command === "/skills" || command.startsWith("/skills ")) {
        void doSkills(command.slice("/skills".length).trim())
        return
      }
      if (command === "/provider" || command.startsWith("/provider ")) {
        if (mode !== "live") printLine("The provider picker needs the live server.")
        else setProviderPickerOpen(true)
        return
      }
      if (command === "/workers" || command.startsWith("/workers ")) {
        void doWorkers(command.slice("/workers".length).trim())
        return
      }
      if (command === "/scoreboard" || command.startsWith("/scoreboard ")) {
        void doScoreboard(command.slice("/scoreboard".length).trim())
        return
      }
      if (command === "/usage" || command.startsWith("/usage ")) {
        void doUsage()
        return
      }
      if (command === "/sidekick" || command.startsWith("/sidekick ")) {
        doSidekick(command.slice("/sidekick".length).trim())
        return
      }
      if (command === "/fork" || command.startsWith("/fork ")) {
        doFork(command.slice("/fork".length).trim())
        return
      }
      if (command === "/rewind") {
        void doRewind()
        return
      }
      const images = attachmentsRef.current
      setAttachments([]) // consume the pasted images with this message
      const shownText = display ?? text
      const shown =
        shownText || (images.length ? `📎 ${images.length} image${images.length === 1 ? "" : "s"}` : shownText)
      // While a turn is in flight the server owns both paths: plain Enter queues
      // the prompt, while Option+Enter buffers an interjection for the next safe
      // main-thread tool boundary.
      if (mode === "live" && runningRef.current) {
        void postMessage(text, shown, images, false, false, undefined, opts?.delivery === "interject" ? "interject" : "queue")
        return
      }
      if (mode === "mock") {
        setState((s) => pushUser(s, shown))
        setStartedAt(Date.now())
        const gen = demo === "threads" ? mockThreadsRun(text) : mockRun(text)
        for await (const ev of gen) apply(ev)
        return
      }
      // The user line is echoed only once the server ACCEPTS: a cache-guard 409
      // parks the message instead, and nothing should look sent.
      const skill = pendingSkill
      setPendingSkill(null)
      await postMessage(text, shown, images, false, opts?.delivery === "steer", skill)
    },
    [mode, apply, demo, postMessage, pendingSkill],
  )

  // Cache-guard confirm bar: enter/y sends anyway (force), esc/n hands the
  // message (text + attachments) back to the input untouched.
  const confirmPendingSend = useCallback(() => {
    if (!pendingSend) return
    setPendingSend(null)
    void postMessage(pendingSend.text, pendingSend.shown, pendingSend.images, true)
  }, [pendingSend, postMessage])

  const cancelPendingSend = useCallback(() => {
    if (!pendingSend) return
    setPendingSend(null)
    setAttachments(pendingSend.images)
    if (pendingSend.text) setPrefill((p) => ({ text: pendingSend.text, nonce: (p?.nonce ?? 0) + 1 }))
  }, [pendingSend])

  useInput(
    (input, key) => {
      if (!pendingSend) return
      if (key.return || input === "y" || input === "Y") return confirmPendingSend()
      if (key.escape || input === "n" || input === "N") cancelPendingSend()
    },
    { isActive: rawSupported && pendingSend != null },
  )

  // Passive cold-cache watch: while the session is idle, ask the server whether
  // the NEXT send would rebuild a cold cache, and show the warning above the
  // input — BEFORE any tokens are spent — instead of after the turn starts.
  useEffect(() => {
    if (mode !== "live" || state.status === "running") return
    let cancelled = false
    const check = async () => {
      const id = sessionIdRef.current
      if (!id) return
      try {
        const res = await fetch(baseUrl + ROUTES.cacheStatus(id))
        const body = (await res.json()) as CacheStatusResponse
        if (!cancelled) setCacheCold(body.cold)
      } catch {
        // keep the last known state; this is advisory only
      }
    }
    void check()
    const t = setInterval(check, 30_000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [mode, baseUrl, state.status])

  // Print a one-shot assistant line into the transcript (used by slash commands).
  const printLine = useCallback(
    (text: string) => {
      apply({ type: "message.start", role: "assistant" })
      apply({ type: "message.delta", text })
      apply({ type: "message.end" })
    },
    [apply],
  )

  // Ctrl+V in the input — grab an image off the clipboard and attach it.
  const onPasteImage = useCallback(async () => {
    if (mode !== "live") {
      toast.show({ message: "Image paste needs the live server (--live)", variant: "warning" })
      return
    }
    const img = await grabClipboardImage()
    if (img) {
      setAttachments((a) => [...a, img])
      toast.show({ message: "📎 Image attached — type a message and press enter", variant: "success" })
    } else {
      toast.show({ message: "No image on the clipboard", variant: "warning" })
    }
  }, [mode, toast])

  // GET /api/providers (live only). Returns [] on any failure.
  const fetchProviders = useCallback(async (): Promise<ProviderRow[]> => {
    try {
      const res = await fetch(baseUrl + "/api/providers")
      const body = (await res.json()) as { providers?: ProviderRow[] }
      return body.providers ?? []
    } catch {
      return []
    }
  }, [baseUrl])

  // /login — open an arrow-navigable picker so you choose WHICH provider to log in to.
  const doLogin = useCallback(async () => {
    if (mode !== "live") {
      printLine("/login needs the live server (run the server, then the TUI with --live).")
      return
    }
    const providers = await fetchProviders()
    if (providers.length === 0) {
      printLine("No providers available (is the server running?).")
      return
    }
    const firstNeedsLogin = providers.findIndex((p) => !p.ready)
    setLoginPicker({ providers, selected: firstNeedsLogin >= 0 ? firstNeedsLogin : 0 })
  }, [mode, fetchProviders, printLine])
  const openOnboarding = useCallback(() => { if (mode === "live") setOnboardingOpen(true) }, [mode])
  useEffect(() => {
    if (mode !== "live") return
    fetch(baseUrl + "/api/onboarding").then((r) => r.json()).then((p: { onboardedAt?: number }) => { if (!p.onboardedAt) setOnboardingOpen(true) }).catch(() => {})
  }, [mode, baseUrl])

  // Initiate login for the chosen provider (called on enter in the picker).
  // Uses the browser loopback flow and OPENS the browser for you; the server's
  // callback captures the token automatically. Then we poll status until ready.
  const initiateLogin = useCallback(
    async (p: ProviderRow) => {
      setLoginPicker(null)
      if (p.ready) {
        printLine(`${p.id} is already logged in. Use /model to select it.`)
        return
      }
      try {
        const res = await fetch(baseUrl + `/api/auth/${p.id}/login`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ method: "browser" }),
        })
        const body = (await res.json()) as LoginInitiation | { error: string }
        if ("error" in body) {
          printLine(`Login for ${p.id} failed: ${body.error}`)
          return
        }
        if (body.kind === "ready") {
          printLine(body.instructions)
          return
        }
        const opened = body.kind === "browser-opened" || openBrowser(body.url)
        printLine(
          opened
            ? body.instructions
            : `Couldn't open a browser automatically. Open this URL to sign in to ${p.id}:\n  ${body.kind === "url" ? body.url : ""}`,
        )
        // Poll until the server has stored a token (loopback callback fired).
        const deadline = Date.now() + 150_000
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 2000))
          try {
            const s = await fetch(baseUrl + `/api/auth/${p.id}/status`)
            const sb = (await s.json()) as { ready?: boolean }
            if (sb.ready) {
              printLine(`✓ Logged in to ${p.id}. Run /model to switch to it.`)
              return
            }
          } catch {
            /* keep waiting */
          }
        }
        printLine(`Still waiting on ${p.id} login. Finish in the browser, then run /model.`)
      } catch (err) {
        printLine(`Login request failed: ${String(err)}`)
      }
    },
    [baseUrl, printLine],
  )

  // Picker navigation: ↑/↓ move, enter selects, esc cancels. Active only while open.
  useInput(
    (_input, key) => {
      if (!loginPicker) return
      if (key.upArrow) {
        setLoginPicker((s) => (s ? { ...s, selected: (s.selected - 1 + s.providers.length) % s.providers.length } : s))
        return
      }
      if (key.downArrow) {
        setLoginPicker((s) => (s ? { ...s, selected: (s.selected + 1) % s.providers.length } : s))
        return
      }
      if (key.return) {
        const p = loginPicker.providers[loginPicker.selected]
        if (p) void initiateLogin(p)
        return
      }
      if (key.escape) setLoginPicker(null)
    },
    { isActive: rawSupported && loginPicker != null },
  )

  // /resume — pick a previous thread in this repo and reattach to it. The SSE
  // history replay rebuilds the whole transcript (past user turns included), so
  // the picker only chooses WHICH session id the live effect opens.
  const doResume = useCallback(async () => {
    if (mode !== "live") {
      printLine("/resume needs the live server (run the server, then the TUI with --live).")
      return
    }
    try {
      const res = await fetch(`${baseUrl + ROUTES.listSessions}?cwd=${encodeURIComponent(process.cwd())}`)
      const body = (await res.json()) as ListSessionsResponse
      // Hide the thread we're already on, and never-used ones (no events means
      // last_activity never moved past creation — every TUI launch leaves one).
      const sessions = body.sessions.filter(
        (s) => s.sessionId !== sessionIdRef.current && s.lastActivity > s.createdAt,
      )
      if (sessions.length === 0) {
        printLine("No previous threads in this repo yet.")
        return
      }
      const firstDetached = sessions.findIndex((s) => !s.attached)
      setResumePicker({ sessions, selected: firstDetached >= 0 ? firstDetached : 0 })
    } catch (err) {
      printLine(`Resume failed: ${String(err)}`)
    }
  }, [mode, baseUrl, printLine])

  // THE session-switch path. Wipes local UI exactly like /clear, then points the
  // live-session effect at an EXISTING id so its SSE history replays. /resume,
  // /rewind (truncated history), /fork (the child) and a remote session.rewound
  // all funnel through here — there is deliberately no second attach path.
  const attachSession = useCallback((sessionId: string) => {
    setResumePicker(null)
    setRewindPicker(null)
    setForkPicker(null)
    setState(initialState)
    setStartedAt(null)
    setCacheCold(null)
    setPendingSend(null)
    setGoal(null)
    setAttachments([])
    setPrefill(null)
    setAuthoritativeQueueCount(0)
    setBackground({ tasks: 0, monitors: 0 })
    resumeTargetRef.current = sessionId
    sessionIdRef.current = null
    setSessionKey((k) => k + 1)
  }, [])
  // `apply` (the SSE reducer) is defined above both of these but must react to a
  // session.rewound event, so it reaches the current pair through this ref.
  onRemoteRewindRef.current = (sessionId, turn) => {
    printLine(`Session rewound to turn ${turn} — reattaching.`)
    attachSession(sessionId)
  }

  // /rewind — restore files AND conversation to an earlier turn. The picker only
  // chooses the turn; on confirm the server truncates and we RE-ATTACH, so the
  // replayed (now shorter) history is what rebuilds the transcript.
  const doRewind = useCallback(async () => {
    if (mode !== "live") {
      printLine("/rewind needs the live server (run the server, then the TUI with --live).")
      return
    }
    const id = sessionIdRef.current
    if (!id) {
      printLine("/rewind needs an active session.")
      return
    }
    try {
      const res = await fetch(baseUrl + ROUTES.rewindPoints(id))
      const body = (await res.json()) as RewindPointsResponse & { error?: string }
      if (!res.ok || body.error) {
        printLine(`Rewind failed: ${body.error || `HTTP ${res.status}`}`)
        return
      }
      const points = body.points ?? []
      if (points.length === 0) {
        printLine("No earlier turns to rewind to yet.")
        return
      }
      if (!points.some((p) => p.complete)) {
        printLine("No completed turn to rewind to yet.")
        return
      }
      setRewindPicker({ points })
    } catch (err) {
      printLine(`Rewind failed: ${String(err)}`)
    }
  }, [mode, baseUrl, printLine])

  // Second Enter in the picker landed: commit the rewind. A 409 means the server
  // refused (session busy) — that text stays IN the picker so the choice is kept.
  const confirmRewind = useCallback(
    async (point: RewindPoint) => {
      const id = sessionIdRef.current
      if (!id) return
      setRewindPicker((s) => (s ? { ...s, busy: true, error: null } : s))
      try {
        const res = await fetch(baseUrl + ROUTES.rewind(id), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ turn: point.turn }),
        })
        const body = (await res.json()) as { sessionId?: string; turn?: number; error?: string }
        if (!res.ok || body.error) {
          setRewindPicker((s) => (s ? { ...s, busy: false, error: body.error || `HTTP ${res.status}` } : s))
          return
        }
        // Re-attach to the SAME session: its truncated history replays cleanly.
        attachSession(body.sessionId || id)
        printLine(`Rewound to turn ${point.turn} — files and conversation restored.`)
      } catch (err) {
        setRewindPicker((s) => (s ? { ...s, busy: false, error: String(err) } : s))
      }
    },
    [baseUrl, attachSession, printLine],
  )

  // POST the fork and switch this TUI onto the child session.
  const postFork = useCallback(
    async (opts: { worktree?: boolean; directive?: string }, fromPicker: boolean) => {
      const id = sessionIdRef.current
      if (!id) {
        printLine("/fork needs an active session.")
        return
      }
      // The parent's title for the notice line; best-effort, never fatal.
      let parentTitle = "this session"
      try {
        const res = await fetch(`${baseUrl + ROUTES.listSessions}?cwd=${encodeURIComponent(process.cwd())}`)
        const body = (await res.json()) as ListSessionsResponse
        parentTitle = body.sessions.find((s) => s.sessionId === id)?.title ?? parentTitle
      } catch {}
      if (fromPicker) setForkPicker((s) => (s ? { ...s, busy: true, error: null } : s))
      try {
        const res = await fetch(baseUrl + ROUTES.fork(id), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ...(opts.worktree === undefined ? {} : { worktree: opts.worktree }),
            ...(opts.directive ? { directive: opts.directive } : {}),
          }),
        })
        const body = (await res.json()) as Partial<ForkResponse> & { error?: string }
        if (!res.ok || body.error || !body.sessionId) {
          const msg = body.error || `HTTP ${res.status}`
          if (fromPicker) setForkPicker((s) => (s ? { ...s, busy: false, error: msg } : s))
          else printLine(`Fork failed: ${msg}`)
          return
        }
        // Same mechanism as a resume attach: the child's history replays.
        attachSession(body.sessionId)
        const wt = body.worktree
        printLine(
          `Forked from ${parentTitle} — workspace: ${wt?.path ?? body.workspace ?? ""}` +
            (wt ? ` (branch ${wt.branch})` : ""),
        )
      } catch (err) {
        if (fromPicker) setForkPicker((s) => (s ? { ...s, busy: false, error: String(err) } : s))
        else printLine(`Fork failed: ${String(err)}`)
      }
    },
    [baseUrl, attachSession, printLine],
  )

  // /fork [--worktree|--no-worktree] [directive] — with an explicit flag we post
  // straight away; without one the small ForkPicker asks in place / worktree.
  const doFork = useCallback(
    (rest: string) => {
      if (mode !== "live") {
        printLine("/fork needs the live server (run the server, then the TUI with --live).")
        return
      }
      if (!sessionIdRef.current) {
        printLine("/fork needs an active session.")
        return
      }
      const parsed = parseForkArgs(rest)
      if (parsed.worktree === undefined) {
        setForkPicker({ directive: parsed.directive })
        return
      }
      void postFork(parsed, false)
    },
    [mode, printLine, postFork],
  )

  // Resume-picker navigation: ↑/↓ move, enter reattaches, esc cancels.
  useInput(
    (_input, key) => {
      if (!resumePicker) return
      if (key.upArrow) {
        setResumePicker((s) => (s ? { ...s, selected: (s.selected - 1 + s.sessions.length) % s.sessions.length } : s))
        return
      }
      if (key.downArrow) {
        setResumePicker((s) => (s ? { ...s, selected: (s.selected + 1) % s.sessions.length } : s))
        return
      }
      if (key.return) {
        const row = resumePicker.sessions[resumePicker.selected]
        if (row) attachSession(row.sessionId)
        return
      }
      if (key.escape) setResumePicker(null)
    },
    { isActive: rawSupported && resumePicker != null },
  )

  // /model — open the fuzzy model picker (provider → model → effort/speed).
  const doModel = useCallback(() => {
    if (mode !== "live") {
      printLine("The model picker needs the live server (run the server, then the TUI with --live).")
      return
    }
    setModelPickerOpen(true)
  }, [mode, printLine])

  const doProvider = useCallback(() => {
    if (mode !== "live") { printLine("The provider picker needs the live server."); return }
    setProviderPickerOpen(true)
  }, [mode, printLine])

  // /workers — inspect zero-config routes or override one provider-qualified target.
  const doWorkers = useCallback(
    async (rest: string) => {
      if (mode !== "live") { printLine("Workflow worker routing needs the live server."); return }
      const parts = rest.split(/\s+/).filter(Boolean)
      const action = (parts[0] ?? "list").toLowerCase()
      interface WorkerTarget {
        provider: string
        model: string
        billing: "subscription" | "free" | "metered" | "unknown"
        automatic: boolean
        effort: string
        tags: string[]
      }
      const request = async (method: string, payload?: Record<string, unknown>): Promise<WorkerTarget[]> => {
        const res = await fetch(baseUrl + "/api/workflow-targets", {
          method,
          headers: payload ? { "content-type": "application/json" } : undefined,
          body: payload ? JSON.stringify(payload) : undefined,
        })
        const body = (await res.json()) as { targets?: WorkerTarget[]; error?: string }
        if (!res.ok || body.error) throw new Error(body.error || `HTTP ${res.status}`)
        return body.targets ?? []
      }
      try {
        if (action === "list" || action === "ls") {
          const targets = await request("GET")
          const useful = targets.filter((target) => Array.isArray(target.tags) && (target.tags.length || target.automatic))
          printLine(
            useful.length
              ? useful.map((target) =>
                  `· ${target.provider}/${target.model} · ${target.billing} · ${target.automatic ? "auto" : "manual"} · ${target.effort}` +
                  `${target.tags.length ? ` · ${target.tags.join(", ")}` : ""}`,
                ).join("\n")
              : "No workflow worker targets are currently available.",
          )
          return
        }
        const provider = parts[1], modelId = parts[2]
        if (!provider || !modelId) throw new Error("Usage: /workers tag|auto|reset <provider> <model> [value]")
        if (action === "reset") {
          await request("DELETE", { provider, model: modelId })
          printLine(`Workflow routing reset: ${provider}/${modelId}.`)
          return
        }
        if (action === "tag") {
          const tags = parts.slice(3).join(" ").split(",").map((tag) => tag.trim()).filter(Boolean)
          if (!tags.length) throw new Error("Provide comma-separated tags, for example: frontend,design")
          await request("PUT", { provider, model: modelId, tags })
          printLine(`Workflow tags: ${provider}/${modelId} → ${tags.join(", ")}.`)
          return
        }
        if (action === "auto") {
          const value = parts[3]?.toLowerCase()
          if (value !== "on" && value !== "off") throw new Error("Use /workers auto <provider> <model> on|off")
          await request("PUT", { provider, model: modelId, automatic: value === "on" })
          printLine(`Automatic workflow routing ${value}: ${provider}/${modelId}.`)
          return
        }
        throw new Error("Usage: /workers list · /workers tag <provider> <model> <tag,tag> · /workers auto <provider> <model> on|off · /workers reset <provider> <model>")
      } catch (err) {
        printLine(`Workflow routing: ${(err as Error).message}`)
      }
    },
    [mode, baseUrl, printLine],
  )

  // /scoreboard — read-only model leaderboard (rated work per model+kind).
  // Bare = every session on this server; `/scoreboard session` scopes to this one.
  const doScoreboard = useCallback(
    async (rest: string) => {
      if (mode !== "live") { printLine("The scoreboard needs the live server."); return }
      const scoped = /^session\b/i.test(rest.trim())
      const sid = sessionIdRef.current
      if (scoped && !sid) { printLine("No session yet — send a message first, then `/scoreboard session`."); return }
      const scope = scoped ? "this session" : "all sessions"
      try {
        const url = new URL(baseUrl + "/api/scoreboard")
        if (scoped && sid) url.searchParams.set("session", sid)
        const res = await fetch(url)
        if (!res.ok) {
          throw new Error(res.status === 404 ? "this server build doesn't serve /api/scoreboard yet" : `HTTP ${res.status}`)
        }
        const body = (await res.json()) as ScoreboardResponse
        const table = renderScoreboard(body.rows ?? [])
        printLine(
          table
            ? `Scoreboard · ${scope}\n\n\`\`\`\n${table}\n\`\`\``
            : `Scoreboard · ${scope}: no rated work yet — rate a turn and models start showing up here.`,
        )
      } catch (err) {
        printLine(`Scoreboard: ${(err as Error).message}`)
      }
    },
    [mode, baseUrl, printLine],
  )

  // /usage — this session's token + cost spend, grouped by role.
  const doUsage = useCallback(async () => {
    if (mode !== "live") { printLine("Usage needs the live server."); return }
    const sid = sessionIdRef.current
    if (!sid) { printLine("No session yet — send a message first, then `/usage`."); return }
    try {
      const url = new URL(baseUrl + "/api/usage")
      url.searchParams.set("session", sid)
      const res = await fetch(url)
      if (!res.ok) {
        throw new Error(res.status === 404 ? "this server build doesn't serve /api/usage yet" : `HTTP ${res.status}`)
      }
      const body = (await res.json()) as UsageResponse
      const table = renderUsage({ roles: body.roles ?? [], totals: body.totals })
      if (!table) {
        printLine("Usage: nothing spent in this session yet.")
        return
      }
      printLine(`Usage · this session\n\n\`\`\`\n${table}\n\`\`\`\n${usageTotalsLine(body.totals)}`)
    } catch (err) {
      printLine(`Usage: ${(err as Error).message}`)
    }
  }, [mode, baseUrl, printLine])

  const doModelCatalog = useCallback(
    async (rest: string) => {
      if (!rest) {
        doModel()
        return
      }
      if (mode !== "live") {
        printLine("Model catalog changes need the live server.")
        return
      }
      const [action, provider, model] = rest.split(/\s+/).filter(Boolean)
      if (!["add", "hide", "restore", "list"].includes(action ?? "") || !provider || (action !== "list" && !model)) {
        printLine("Usage: /model add|hide|restore <provider> <model-id> · /model list <provider>")
        return
      }
      try {
        const res = await fetch(`${baseUrl}/api/providers/${encodeURIComponent(provider)}/models/catalog`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action, ...(model ? { model } : {}) }),
        })
        const body = (await res.json()) as any
        if (!res.ok || body.error) throw new Error(body.error || `HTTP ${res.status}`)
        if (action === "list") {
          const custom = Object.keys(body.added ?? {})
          const hidden = body.hidden ?? []
          printLine(
            `${provider} catalog: ${body.visible?.length ?? 0} visible` +
              `${custom.length ? ` · custom: ${custom.join(", ")}` : ""}` +
              `${hidden.length ? ` · hidden: ${hidden.join(", ")}` : ""}`,
          )
        } else if (action === "add") {
          printLine(`Model added: ${provider}/${model}${body.verified ? "" : " · unverified"}. Open /model to select it.`)
        } else {
          printLine(`Model ${action === "hide" ? "hidden" : "restored"}: ${provider}/${model}.`)
        }
      } catch (err) {
        printLine(`Model catalog update failed: ${(err as Error).message}`)
      }
    },
    [mode, baseUrl, printLine, doModel],
  )

  // /skills — manage git skill repositories (add/remove/update/list).
  const doSkills = useCallback(
    async (rest: string) => {
      if (!rest.trim()) {
        if (mode !== "live") {
          printLine("The skills picker needs the live server.")
        } else {
          setSkillsPickerOpen(true)
        }
        return
      }
      if (mode !== "live") {
        printLine("Skill repo management needs the live server.")
        return
      }
      const parts = rest.split(/\s+/).filter(Boolean)
      const action = (parts[0] ?? "list").toLowerCase()
      if (!["add", "remove", "rm", "update", "list", "ls"].includes(action)) {
        printLine(
          "Usage: /skills list · /skills add <git-url> [branch] · /skills remove <id|url> · /skills update [id]",
        )
        return
      }
      const normalized =
        action === "rm" ? "remove" : action === "ls" ? "list" : action
      let body: Record<string, string> = { action: normalized }
      if (normalized === "add") {
        const url = parts[1]
        if (!url) {
          printLine("Usage: /skills add <git-url> [branch]")
          return
        }
        body = { action: "add", url }
        if (parts[2]) body.branch = parts[2]
      } else if (normalized === "remove") {
        const key = parts[1]
        if (!key) {
          printLine("Usage: /skills remove <id|url>")
          return
        }
        body = { action: "remove", id: key }
      } else if (normalized === "update") {
        body = { action: "update" }
        if (parts[1]) body.id = parts[1]
      }
      try {
        const res = await fetch(`${baseUrl}/api/skill-repos`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        })
        const data = (await res.json()) as any
        if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`)
        if (normalized === "list") {
          try {
            const catalog = await fetch(`${baseUrl}/api/skills?session=${encodeURIComponent(sessionIdRef.current ?? "")}`)
            const listed = (await catalog.json()) as { skills?: Array<{ name: string; enabled: boolean; sourceLabel: string }> }
            if (catalog.ok && listed.skills?.length) {
              printLine(listed.skills.map((s) => `· ${s.enabled ? "on " : "off"} ${s.name} [${s.sourceLabel}]`).join("\n"))
            }
          } catch { /* repo listing below remains useful */ }
          const repos = data.repos ?? []
          if (repos.length === 0) {
            printLine("No managed skill repos. /skills add <git-url> to install a pack.")
          } else {
            printLine(
              repos
                .map(
                  (r: { id: string; url: string; present: boolean; branch?: string; lastError?: string }) =>
                    `· ${r.id}${r.present ? "" : " (missing)"}${r.branch ? ` @${r.branch}` : ""} — ${r.url}` +
                    (r.lastError ? ` · error: ${r.lastError}` : ""),
                )
                .join("\n"),
            )
          }
        } else if (normalized === "add") {
          printLine(
            `Skill repo added: ${data.repo?.id} → ${data.repo?.path}. Skills appear in search_skills immediately.`,
          )
        } else if (normalized === "remove") {
          printLine(`Skill repo removed: ${data.id}.`)
        } else {
          const failed = data.failed ?? 0
          printLine(
            `Updated ${data.updated ?? 0} skill repo(s)` +
              (failed ? ` · ${failed} failed` : "") +
              ".",
          )
        }
      } catch (err) {
        printLine(`Skill repo update failed: ${(err as Error).message}`)
      }
    },
    [mode, baseUrl, printLine],
  )

  // Called when the picker finishes selecting (or reports an error): close it,
  // update the status line, and echo a summary line into the transcript.
  const onModelDone = useCallback(
    (result: ModelSelectionResult, summary: string) => {
      setModelPickerOpen(false)
      setCurrentSel({
        provider: result.provider,
        model: result.model,
        effort: result.effort ?? null,
        speed: result.speed ?? null,
      })
      printLine(summary)
    },
    [printLine],
  )

  // /advisor — open the picker that sets the always-on advisor's model.
  const doAdvisor = useCallback(() => {
    if (mode !== "live") {
      printLine("The advisor picker needs the live server (run the server, then the TUI with --live).")
      return
    }
    setAdvisorPickerOpen(true)
  }, [mode, printLine])

  // Called when the advisor picker finishes: close it, refresh the status line
  // from the server (so the active/inactive state is accurate), echo a summary.
  const onAdvisorDone = useCallback(
    (_result: AdvisorSelectionResult, summary: string) => {
      setAdvisorPickerOpen(false)
      void refreshAdvisor()
      printLine(summary)
    },
    [printLine, refreshAdvisor],
  )

  // /sidekick [name] — open the picker for the default seat, or for the NAMED
  // seat `name` (e.g. `/sidekick frontend` seats a domain worker).
  const doSidekick = useCallback(
    (rest = "") => {
      if (mode !== "live") {
        printLine("The sidekick picker needs the live server (run the server, then the TUI with --live).")
        return
      }
      const name = rest.trim().toLowerCase()
      if (name && !/^[a-z][a-z0-9_-]{0,23}$/.test(name)) {
        printLine(`Seat names are short lowercase slugs (got "${name}"). Try /sidekick frontend.`)
        return
      }
      if (name && name !== "default") setSidekickPicker({ seat: name })
      else setSidekickSeatMenuOpen(true)
    },
    [mode, printLine],
  )

  // Called when the sidekick picker finishes: close it, refresh the status line,
  // echo a summary.
  const onSidekickDone = useCallback(
    (_result: AdvisorSelectionResult, summary: string) => {
      setSidekickPicker(null)
      void refreshSidekick()
      printLine(summary)
    },
    [printLine, refreshSidekick],
  )

  // /goal — set an objective and let the agent work autonomously toward it, or
  // manage the current one. `rest` is everything after "/goal":
  //   ""                     -> show current goal status
  //   pause | resume | clear -> lifecycle action
  //   [--turns N] <text>     -> set the objective (optional turn budget) and start
  const doGoal = useCallback(
    async (rest: string) => {
      if (mode !== "live") {
        printLine("Goal mode needs the live server (run the server, then the TUI with --live).")
        return
      }
      const id = sessionIdRef.current
      if (!id) {
        printLine("No live session yet.")
        return
      }
      const url = baseUrl + ROUTES.goal(id)
      const trimmed = rest.trim()

      // Bare `/goal` -> status query (no server event, so print it here).
      if (!trimmed) {
        try {
          const res = await fetch(url)
          const body = (await res.json()) as GoalStateResponse
          if (!body.goal) {
            printLine(
              "No goal set. `/goal <objective>` starts one (autonomous until done); `/goal --workflows <objective>` runs it as a workflow-orchestrator; `/goal --turns 30 <objective>` sets a turn budget; `/goal pause|resume|clear` manages it.",
            )
            return
          }
          setGoal(body.goal)
          const modeTag = body.goal.mode === "workflows" ? ", orchestrator" : ""
          printLine(`Goal (${body.goal.status}${modeTag}, turn ${body.goal.turns}/${body.goal.maxTurns}): ${body.goal.objective}`)
        } catch (err) {
          printLine(`Goal status failed: ${String(err)}`)
        }
        return
      }

      const lower = trimmed.toLowerCase()
      let payload: GoalRequest
      if (lower === "pause") payload = { action: "pause" }
      else if (lower === "resume" || lower === "continue") payload = { action: "resume" }
      else if (lower === "clear" || lower === "stop" || lower === "cancel") payload = { action: "clear" }
      else {
        // Set a new objective, with optional leading `--turns N` and
        // `--workflows` (alias `--dynamite`) flags in either order (mirrors the
        // server's parseGoalCommand).
        let objective = trimmed
        let maxTurns: number | undefined
        let goalMode: GoalRequest["mode"]
        for (;;) {
          const turns = objective.match(/^--turns\s+(\d+)\s+([\s\S]+)$/)
          if (turns) {
            maxTurns = Number(turns[1])
            objective = turns[2]!.trim()
            continue
          }
          const workflows = objective.match(/^--(?:workflows|dynamite)\s+([\s\S]+)$/)
          if (workflows) {
            goalMode = "workflows"
            objective = workflows[1]!.trim()
            continue
          }
          break
        }
        payload = { objective, ...(maxTurns ? { maxTurns } : {}), ...(goalMode ? { mode: goalMode } : {}) }
      }

      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        })
        const body = (await res.json()) as GoalStateResponse | { error: string }
        if ("error" in body) {
          printLine(`Goal: ${body.error}`)
          return
        }
        // set/resume/pause/clear all stream a goal.update marker into the transcript,
        // which also updates goal state via apply() — so nothing to print here.
        setGoal(body.goal)
      } catch (err) {
        printLine(`Goal request failed: ${String(err)}`)
      }
    },
    [mode, baseUrl, printLine],
  )

  // /shipit — hand the plan agreed in THIS conversation off to a fresh
  // goal-orchestrator session. The server injects a hidden prompt telling the
  // current session's model to distill a handoff brief and call ship_goal, which
  // creates the new session and starts its workflows-mode goal. `rest` is
  // optional extra notes folded into the brief.
  const doShipIt = useCallback(
    async (rest: string) => {
      if (mode !== "live") {
        printLine("/shipit needs the live server (run the server, then the TUI with --live).")
        return
      }
      const id = sessionIdRef.current
      if (!id) {
        printLine("No live session yet — nothing to ship. Talk through the plan first, then /shipit.")
        return
      }
      try {
        const notes = rest.trim()
        const res = await fetch(baseUrl + ROUTES.ship(id), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(notes ? { notes } : {}),
        })
        if (!res.ok) {
          printLine(`Shipit failed: HTTP ${res.status}`)
          return
        }
        printLine(
          "Shipping — this session is writing the handoff brief and will spawn a fresh goal-orchestrator session (ship_goal). The new session appears in the sessions list once created.",
        )
      } catch (err) {
        printLine(`Shipit request failed: ${String(err)}`)
      }
    },
    [mode, baseUrl, printLine],
  )

  // /cacheguard — show or set the confirm-before-resend threshold. `rest` is
  // everything after "/cacheguard":
  //   ""                -> show the current guard
  //   <N | Nk | Nm | off> -> set the threshold in tokens, or disable the guard
  const doCacheGuard = useCallback(
    async (rest: string) => {
      if (mode !== "live") {
        printLine("/cacheguard needs the live server (run the server, then the TUI with --live).")
        return
      }
      const trimmed = rest.trim().toLowerCase()
      try {
        if (!trimmed) {
          const res = await fetch(baseUrl + ROUTES.cacheGuard)
          const body = (await res.json()) as CacheGuardResponse
          printLine(
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
            printLine("Usage: /cacheguard <tokens|off> — e.g. /cacheguard 100k, /cacheguard 50000, /cacheguard off")
            return
          }
          tokens = Math.round(Number(m[1]) * (m[2] === "m" ? 1_000_000 : m[2] === "k" ? 1_000 : 1))
        }
        const res = await fetch(baseUrl + ROUTES.cacheGuard, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tokens }),
        })
        const body = (await res.json()) as CacheGuardResponse
        printLine(
          body.tokens == null
            ? "Cache guard off — cold-cache sends go through without confirmation."
            : `Cache guard set: confirm before re-sending ≥${fmtTokens(body.tokens)} tokens on a cold cache.`,
        )
      } catch (err) {
        printLine(`Cache guard request failed: ${String(err)}`)
      }
    },
    [mode, baseUrl, printLine],
  )

  // Apply a saved mode by name and fold the response into the status line
  // (executor) + advisor/sidekick chips — the shared half of `/mode <name>` and
  // `/incognito`, so both take exactly the same path. Returns the apply payload,
  // or null when the server refused (the caller's user has already been told why).
  const applyModeNamed = useCallback(
    async (name: string) => {
      const res = await fetch(baseUrl + ROUTES.applyMode(name), { method: "POST" })
      const body = (await res.json()) as
        | { applied: string; provider: string; model: string | null; effort?: string | null; speed?: string | null }
        | { error: string }
      if ("error" in body) {
        printLine(`Mode: ${body.error} — \`/mode\` lists what's saved.`)
        return null
      }
      setCurrentSel({
        provider: body.provider,
        model: body.model,
        effort: body.effort ?? null,
        speed: body.speed ?? null,
      })
      void refreshAdvisor()
      void refreshSidekick()
      return body
    },
    [baseUrl, printLine, refreshAdvisor, refreshSidekick],
  )

  // /mode — named executor+sidekick+advisor trios. `rest` is everything after "/mode":
  //   ""             -> list saved modes + the current trio
  //   <name>         -> apply that mode (model + sidekick + advisor switch as one unit)
  //   save <name>    -> snapshot the current trio under <name>
  //   rm <name>      -> delete <name>
  const doMode = useCallback(
    async (rest: string) => {
      if (mode !== "live") {
        printLine("/mode needs the live server (run the server, then the TUI with --live).")
        return
      }
      const effortParen = (e?: string | null) => (e ? ` (${e})` : "")
      const fmtSeats = (spec: ModeSpec) =>
        spec.sidekickSeats && Object.keys(spec.sidekickSeats).length > 0
          ? ` + seats ${Object.entries(spec.sidekickSeats)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([n, s]) => `${n}=${prettyModel(s.model)}${effortParen(s.effort)}`)
              .join(", ")}`
          : ""
      const fmtSpec = (spec: ModeSpec) =>
        `${prettyModel(spec.model)}${effortParen(spec.effort)} + sidekick ${
          spec.sidekick ? `${prettyModel(spec.sidekick.model)}${effortParen(spec.sidekick.effort)}` : "inherit"
        }${fmtSeats(spec)} + advisor ${spec.advisor ? `${prettyModel(spec.advisor.model)}${effortParen(spec.advisor.effort)}` : "off"}`
      const trimmed = rest.trim()
      // Bare `/mode` opens the interactive menu; subcommands stay text (scripting).
      if (!trimmed) {
        setModeMenuOpen(true)
        return
      }
      try {

        const save = trimmed.match(/^save\s+(\S+)$/i)
        if (save) {
          const name = save[1]!
          const cur = await fetch(baseUrl + ROUTES.modes)
          const { current } = (await cur.json()) as ModesResponse
          const res = await fetch(baseUrl + ROUTES.modes, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name }),
          })
          const body = (await res.json()) as ModesResponse | { error: string }
          if ("error" in body) {
            printLine(`Mode save failed: ${body.error}`)
            return
          }
          const samePair =
            current.advisor && current.advisor.provider === current.provider && current.advisor.model === current.model
          printLine(
            `Mode "${name}" saved: ${fmtSpec(current)}.${
              samePair ? " ⚠ advisor equals the executor — it will be suppressed; pick a different advisor for this mode." : ""
            }`,
          )
          return
        }

        const rm = trimmed.match(/^(?:rm|delete)\s+(\S+)$/i)
        if (rm) {
          const res = await fetch(baseUrl + ROUTES.deleteMode(rm[1]!), { method: "DELETE" })
          const body = (await res.json()) as ModesResponse | { error: string }
          printLine("error" in body ? `Mode delete failed: ${body.error}` : `Mode "${rm[1]}" deleted.`)
          return
        }

        // Anything else is a mode name to apply.
        const body = await applyModeNamed(trimmed)
        if (!body) return
        printLine(`Mode "${body.applied}" applied: ${prettyModel(body.model)}${effortParen(body.effort)} · ${body.provider}.`)
      } catch (err) {
        printLine(`Mode request failed: ${String(err)}`)
      }
    },
    [mode, baseUrl, printLine, applyModeNamed],
  )
  doModeRef.current = doMode

  // /incognito — sugar over the mode-apply flow: apply an INCOGNITO mode (a
  // saved mode with a provider allowlist) so the NEXT session runs off the
  // record. `rest` is everything after "/incognito":
  //   ""     -> one incognito mode: apply it; several: pick; none: explain
  //   <name> -> apply that mode, but only if it IS an incognito mode
  const doIncognito = useCallback(
    async (rest: string) => {
      if (mode !== "live") {
        printLine("/incognito needs the live server (run the server, then the TUI with --live).")
        return
      }
      try {
        const res = await fetch(baseUrl + ROUTES.modes)
        const body = (await res.json()) as ModesResponse
        const action = resolveIncognitoCommand((body.modes ?? []) as SavedMode[], rest)
        if (action.kind === "none") return printLine(NO_INCOGNITO_MODES)
        if (action.kind === "unknown") return printLine(unknownModeLine(action.name))
        if (action.kind === "not-incognito") return printLine(notIncognitoLine(action.name))
        if (action.kind === "pick") {
          setIncognitoMenuOpen(true)
          return
        }
        const applied = await applyModeNamed(action.name)
        if (!applied) return
        printLine(
          incognitoAppliedLine(
            applied.applied,
            `${prettyModel(applied.model)}${applied.effort ? ` (${applied.effort})` : ""} · ${applied.provider}`,
          ),
        )
      } catch (err) {
        printLine(`Incognito request failed: ${String(err)}`)
      }
    },
    [mode, baseUrl, printLine, applyModeNamed],
  )

  useEffect(() => {
    if (mode !== "live") return
    const refresh = () => {
      void fetch(baseUrl + ROUTES.modes)
        .then((r) => r.json() as Promise<ModesResponse>)
        .then((body) => setSlashModes(body.modes
          .filter((m) => !builtinCommandNames.has(`/${m.name.toLowerCase()}`))
          .map((m) => ({ name: `/${m.name}`, description: `Apply mode: ${prettyModel(m.model)}` }))))
        .catch(() => {})
    }
    refresh()
    const timer = setInterval(refresh, 5000)
    return () => clearInterval(timer)
  }, [baseUrl, mode])

  // Applied a mode from the interactive menu: consume the apply response's full
  // trio to update the status line + advisor/sidekick chips directly (no
  // re-fetch), close the menu, echo the summary.
  const onModeApplied = useCallback(
    (payload: ModeApplyPayload, summary: string) => {
      setModeMenuOpen(false)
      setIncognitoMenuOpen(false)
      setCurrentSel({
        provider: payload.provider,
        model: payload.model,
        effort: payload.effort ?? null,
        speed: payload.speed ?? null,
      })
      if (payload.advisor) {
        setAdvisor({
          enabled: payload.advisor.enabled ?? false,
          provider: payload.advisor.provider,
          model: payload.advisor.model,
          effort: payload.advisor.effort,
          active: Boolean(payload.advisorActive),
        })
      } else {
        void refreshAdvisor()
      }
      if (payload.sidekick) {
        setSidekick({
          enabled: payload.sidekick.enabled ?? false,
          provider: payload.sidekick.provider,
          model: payload.sidekick.model,
          effort: payload.sidekick.effort,
          seats: payload.sidekickSeats ?? {},
        })
      } else {
        void refreshSidekick()
      }
      printLine(summary)
    },
    [printLine, refreshAdvisor, refreshSidekick],
  )

  // Saved/deleted/error from the mode menu: echo the line + close.
  const onModeNotice = useCallback(
    (summary: string) => {
      setModeMenuOpen(false)
      setIncognitoMenuOpen(false)
      printLine(summary)
    },
    [printLine],
  )

  const onCommand = useCallback(
    (name: string) => {
      switch (name) {
        case "/clear": {
          // Local wipe + (in live mode) a real new server session. Keeping the
          // old sessionId would leave the cache-watch armed and keep showing
          // "Cache cold" on an empty-looking thread.
          setState(initialState)
          setStartedAt(null)
          setCacheCold(null)
          setPendingSend(null)
          setGoal(null)
          setAttachments([])
          setPrefill(null)
          setAuthoritativeQueueCount(0)
          setBackground({ tasks: 0, monitors: 0 })
          if (mode === "live") {
            const old = sessionIdRef.current
            if (old) void fetch(baseUrl + ROUTES.interrupt(old), { method: "POST" }).catch(() => {})
            sessionIdRef.current = null
            resumeTargetRef.current = null // next attach is a FRESH session
            setSessionKey((k) => k + 1)
          }
          break
        }
        case "/resume":
          void doResume()
          break
        case "/rewind":
          void doRewind()
          break
        case "/fork":
          doFork("")
          break
        case "/quit":
          exit()
          break
        case "/help":
          printLine(
            "Commands: /clear, /resume, /rewind, /fork, /help, /login, /model, /skills, /provider, /workers, /scoreboard, /usage, /advisor, /sidekick, /mode, /incognito, /goal, /shipit, /cacheguard, /quit. `/incognito [name]` applies an incognito mode so NEW sessions run off the record. `/scoreboard` ranks models by rating (add `session` to scope it); `/usage` shows this session's tokens and cost by role. `/rewind` restores files and conversation to an earlier turn; `/fork [--worktree|--no-worktree] [directive]` branches this session, optionally into a Git worktree. `/workers` shows automatic workflow routes; `/workers tag|auto|reset` changes exceptions. Input: enter to send (queues during a running turn), option+enter to steer a running turn, ctrl+v to attach a clipboard image.",
          )
          break
        case "/login":
          void doLogin()
          break
        case "/onboard":
          openOnboarding()
          break
        case "/model":
          doModel()
          break
        case "/skills":
          void doSkills("")
          break
        case "/provider":
          doProvider()
          break
        case "/workers":
          void doWorkers("")
          break
        case "/scoreboard":
          void doScoreboard("")
          break
        case "/usage":
          void doUsage()
          break
        case "/advisor":
          doAdvisor()
          break
        case "/sidekick":
          doSidekick()
          break
        case "/goal":
          void doGoal("")
          break
        case "/shipit":
          void doShipIt("")
          break
        case "/cacheguard":
          void doCacheGuard("")
          break
        case "/mode":
          void doMode("")
          break
        case "/incognito":
          void doIncognito("")
          break
        default: {
          // Saved modes double as slash commands (/fire applies the "fire"
          // mode). The menu fires them here, not through submit() — without this
          // a menu-selected saved mode would silently do nothing.
          const modeName = savedModeForCommand(name, slashModes)
          if (modeName) doModeRef.current(modeName)
          break
        }
      }
    },
    [printLine, doLogin, doModel, doSkills, doProvider, doWorkers, doScoreboard, doUsage, doAdvisor, doSidekick, doGoal, doShipIt, doCacheGuard, doMode, doIncognito, doResume, exit, mode, baseUrl, slashModes],
  )

  // Mock demo turn so the transcript streams even without a TTY.
  useEffect(() => {
    if (mode === "mock" && autoDemo) {
      const prompt =
        demo === "threads"
          ? "explore the project using a child thread, then summarize"
          : "scaffold a Claude Code style TUI"
      const t = setTimeout(() => void submit(prompt), 300)
      return () => clearTimeout(t)
    }
  }, [mode, autoDemo, submit, demo])

  const running = state.status === "running"
  // More than just the main thread means child threads exist -> show the toggle hint.
  const hasThreads = state.order.length > 1

  // Welcome-banner model label: the REAL active selection (model · provider), not a
  // hardcoded string. Shows "connecting…" until the first /api/model fetch lands.
  const bannerModel =
    mode === "live"
      ? currentSel?.model
        ? `${currentSel.model} · ${currentSel.provider}`
        : "connecting…"
      : "mock transcript"
  const effortParen = (e?: string | null) => (e ? ` (${e})` : "")
  // Styled status drawn into the input's bottom rule (right-aligned). The
  // executor model+effort is the ACCENT headline; sidekick/advisor/goal are DIM
  // chips shown ONLY when present — absence means off, so there are no "off"
  // labels. Separators are BORDER-dim `·`. Mock mode shows a lone `mock` chip;
  // a connecting live session (no selection yet) yields no segments → plain rule.
  const bottomStatus = ((): StatusSegment[] | undefined => {
    if (mode !== "live") return [{ text: "mock", dim: true }]
    if (!currentSel?.model) return undefined // connecting — plain full-width rule
    const chips: StatusSegment[] = []
    // INCOGNITO first, in the (now red) accent — the loudest thing on the rule.
    const ghost = incognitoSegment(incognito)
    if (ghost) chips.push(ghost)
    // Executor: `<model> <effort>` in ACCENT, effort without parens.
    chips.push({
      text: `${prettyModel(currentSel.model)}${currentSel.effort ? ` ${currentSel.effort}` : ""}`,
      color: ACCENT,
    })
    // Sidekick chip — only when enabled. `⚒ sidekick <model>` (the lead's model
    // when the seat inherits), plus a seat
    // suffix: 1 named seat → `+name`, more than one → `+N`.
    if (sidekick?.enabled) {
      const seatNames = Object.keys(sidekick.seats)
      const seatSuffix =
        seatNames.length === 0
          ? ""
          : seatNames.length === 1
            ? ` +${seatNames[0]}`
            : ` +${seatNames.length}`
      // An unconfigured default seat INHERITS the lead's selection — show the
      // effective model (what a handoff actually runs on), not the word "inherit".
      const model = sidekick.model ? prettyModel(sidekick.model) : `${prettyModel(currentSel.model)}`
      chips.push({ text: `⚒ sidekick ${model}${seatSuffix}`, dim: true })
    }
    // Advisor chip — only when enabled AND it has a model; ` ✕` when suppressed.
    if (advisor?.enabled && advisor.model) {
      chips.push({
        text: `✦ advisor ${prettyModel(advisor.model)}${advisor.active ? "" : " ✕"}`,
        dim: true,
      })
    }
    // Goal chip — only when a goal exists; WARNING while active (carries turns),
    // DIM otherwise.
    if (goal) {
      const active = goal.status === "active"
      chips.push({
        text: `goal ${goal.status}${active ? ` ${goal.turns}/${goal.maxTurns}` : ""}`,
        color: active ? WARNING : undefined,
        dim: !active,
      })
    }
    // Interleave BORDER-dim `·` separators between present chips.
    const segments: StatusSegment[] = []
    chips.forEach((c, i) => {
      if (i > 0) segments.push({ text: " · ", color: BORDER, dim: true })
      segments.push(c)
    })
    return segments
  })()

  return (
    <ToastContext.Provider value={toast}>
    <box
      flexDirection="column"
      width="100%"
      height="100%"
      // Finishing a drag anywhere copies the selection (see copySelection).
      // Both events fire the same idempotent handler — it no-ops once the
      // selection is cleared, so a double-fire copies once.
      onMouseUp={copySelection}
      onMouseDragEnd={copySelection}
    >
      {/* OpenTUI owns the whole screen (no terminal scrollback), so the
          transcript lives in a scrollbox pinned to the bottom like a chat. */}
      <scrollbox
        flexGrow={1}
        flexShrink={1}
        stickyScroll
        stickyStart="bottom"
        scrollY
        contentOptions={{ flexDirection: "column" }}
      >
        <WelcomeBanner mode={mode} cwd={cwd} model={bannerModel} incognito={incognito} />
        <Transcript state={state} collapsed={threadsCollapsed} />
      </scrollbox>
      {(running && startedAt != null) || connection === "reconnecting" ? (
        <StatusLine startedAt={startedAt ?? undefined} reconnecting={connection === "reconnecting"} />
      ) : running ? null : (
        // Idle, but background work is still going: the spinner's slot shows what
        // we're waiting on. `running` is re-checked here because the branch above
        // also needs startedAt — a running turn must never show BOTH lines.
        // Renders nothing when both counts are 0.
        <WatchingLine tasks={background.tasks} monitors={background.monitors} />
      )}
      {updateNotice && <text attributes={TextAttributes.DIM}>{updateNotice}</text>}
      <box flexDirection="column" width="100%" marginTop={1} flexShrink={0}>
        {onboardingOpen && <OnboardingWizard baseUrl={baseUrl} onDone={(stamped) => { setOnboardingOpen(false); if (!stamped) void fetch(baseUrl + "/api/onboarding/complete", { method: "POST" }).catch(() => {}) }} onLogin={async (p) => {
          // `active` is LoginPicker display state; initiateLogin never reads it.
          await initiateLogin({ id: p.id, label: p.label, ready: p.ready, active: false })
          try { const r = await fetch(baseUrl + `/api/auth/${p.id}/status`); return Boolean((await r.json()).ready) } catch { return false }
        }} />}
        {loginPicker && <LoginPicker providers={loginPicker.providers} selected={loginPicker.selected} />}
        {resumePicker && <ResumePicker sessions={resumePicker.sessions} selected={resumePicker.selected} />}
        {rewindPicker && (
          <RewindPicker
            points={rewindPicker.points}
            error={rewindPicker.error}
            busy={rewindPicker.busy}
            onConfirm={(point) => void confirmRewind(point)}
            onCancel={() => setRewindPicker(null)}
          />
        )}
        {forkPicker && (
          <ForkPicker
            directive={forkPicker.directive}
            error={forkPicker.error}
            busy={forkPicker.busy}
            onSelect={(worktree) => void postFork({ worktree, directive: forkPicker.directive }, true)}
            onCancel={() => setForkPicker(null)}
          />
        )}
        {skillsPickerOpen && <SkillsPicker baseUrl={baseUrl} sessionId={sessionIdRef.current} onSelect={(name) => { setPendingSkill(name); setSkillsPickerOpen(false) }} onCancel={() => setSkillsPickerOpen(false)} />}
        {modelPickerOpen && (
          <ModelPicker baseUrl={baseUrl} onDone={onModelDone} onCancel={() => setModelPickerOpen(false)} />
        )}
        {providerPickerOpen && (
          <ProviderPicker baseUrl={baseUrl} onDone={(summary) => { setProviderPickerOpen(false); printLine(summary) }} onCancel={() => setProviderPickerOpen(false)} />
        )}
        {advisorPickerOpen && (
          <AdvisorPicker baseUrl={baseUrl} onDone={onAdvisorDone} onCancel={() => setAdvisorPickerOpen(false)} />
        )}
        {sidekickPicker && (
          <AdvisorPicker
            seat="sidekick"
            seatName={sidekickPicker.seat}
            baseUrl={baseUrl}
            onDone={onSidekickDone}
            onCancel={() => setSidekickPicker(null)}
          />
        )}
        {sidekickSeatMenuOpen && (
          <SidekickSeatMenu
            baseUrl={baseUrl}
            currentModel={currentSel?.model ?? undefined}
            onDone={(seat) => {
              setSidekickSeatMenuOpen(false)
              setSidekickPicker(seat ? { seat } : {})
            }}
            onCancel={() => setSidekickSeatMenuOpen(false)}
          />
        )}
        {modeMenuOpen && (
          <ModeMenu
            baseUrl={baseUrl}
            onApplied={onModeApplied}
            onNotice={onModeNotice}
            onCancel={() => setModeMenuOpen(false)}
          />
        )}
        {incognitoMenuOpen && (
          <ModeMenu
            incognitoOnly
            baseUrl={baseUrl}
            onApplied={onModeApplied}
            onNotice={onModeNotice}
            onCancel={() => setIncognitoMenuOpen(false)}
          />
        )}
        {pendingSend ? (
          // The cache guard held this send: nothing ran server-side yet.
          <box flexDirection="column">
            <text fg={WARNING}>
              {"⚠ Cache cold after "}
              {coldReason(pendingSend.warning)}
              {" — sending will re-send ~"}
              {fmtTokens(pendingSend.warning.approxTokens)}
              {" tokens (guard: "}
              {fmtTokens(pendingSend.guardTokens)}
              {")."}
            </text>
            <text attributes={TextAttributes.DIM}>
              {"  enter to send anyway · esc to keep the message unsent · /cacheguard to tune"}
            </text>
          </box>
        ) : (
          cacheCold &&
          !running && (
            // Early heads-up while idle: the next send would rebuild a cold cache.
            <text fg={WARNING}>
              {"⚠ Cache cold ("}
              {coldReason(cacheCold)}
              {") — next message re-sends ~"}
              {fmtTokens(cacheCold.approxTokens)}
              {" tokens. Consider a fresh thread."}
            </text>
          )
        )}
        {/* Server-authoritative queued prompt count. */}
        {authoritativeQueueCount > 0 && <text attributes={TextAttributes.DIM}>{`  ⏎ queued: ${authoritativeQueueCount}`}</text>}
        {pendingSkill && <text fg={ACCENT}>{`  skill: ${pendingSkill} — type your prompt, Esc to clear`}</text>}
        <PromptInput
          disabled={pickerOpen || (running && mode !== "live")}
          running={running && mode === "live"}
          onSubmit={submit}
          onCommand={onCommand}
          commands={[...COMMANDS, ...slashModes]}
          status={bottomStatus}
          threadsHint={hasThreads ? "  ·  ctrl+t to " + (threadsCollapsed ? "expand" : "collapse") + " threads" : ""}
          onPasteImage={onPasteImage}
          attachmentCount={attachments.length}
          baseUrl={mode === "live" ? baseUrl : undefined}
          prefill={prefill}
        />
      </box>
      {/* Ephemeral toasts (copy confirmation at the cursor, image-attach, etc.),
          floated on top of everything. */}
      <ToastOverlay toasts={toasts} />
    </box>
    </ToastContext.Provider>
  )
}
