import React, { useCallback, useEffect, useRef, useState } from "react"
import { Box, Text, useApp, useInput, useStdin } from "ink"
import {
  ROUTES,
  readSSE,
  type AgentEvent,
  type CreateSessionResponse,
  type LoginInitiation,
} from "@chunky/protocol"
import { mockRun } from "@chunky/protocol/mock"
import { mockThreadsRun } from "./mockThreads.js"
import { initialState, pushUser, reduce, type TranscriptState } from "./transcript.js"
import { WelcomeBanner } from "./components/WelcomeBanner.js"
import { Transcript } from "./components/Transcript.js"
import { StatusLine } from "./components/StatusLine.js"
import { PromptInput } from "./components/PromptInput.js"
import { LoginPicker, type ProviderRow } from "./components/LoginPicker.js"
import { ModelPicker, type ModelSelectionResult } from "./components/ModelPicker.js"
import { AdvisorPicker, type AdvisorSelectionResult } from "./components/AdvisorPicker.js"
import { openBrowser } from "./openBrowser.js"
import { grabClipboardImage, type ClipboardImage } from "./clipboardImage.js"

interface Props {
  mode: "mock" | "live"
  baseUrl: string
  cwd: string
  /** In mock mode, auto-run one demo turn on mount (lets the UI stream with no TTY). */
  autoDemo?: boolean
  /** Which mock generator the auto-demo drives ("threads" shows the nested-thread view). */
  demo?: "basic" | "threads"
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

export function App({ mode, baseUrl, cwd, autoDemo = true, demo = "basic" }: Props) {
  const { exit } = useApp()
  const [state, setState] = useState<TranscriptState>(initialState)
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [threadsCollapsed, setThreadsCollapsed] = useState(false)
  // When set, the /login provider picker is open; PromptInput is disabled and
  // arrow/enter/esc drive the picker instead.
  const [loginPicker, setLoginPicker] = useState<{ providers: ProviderRow[]; selected: number } | null>(null)
  // When true, the /model fuzzy picker is open (owns the keyboard while shown).
  const [modelPickerOpen, setModelPickerOpen] = useState(false)
  // When true, the /advisor picker is open (owns the keyboard while shown).
  const [advisorPickerOpen, setAdvisorPickerOpen] = useState(false)
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
  const sessionIdRef = useRef<string | null>(null)
  // Images pasted (Ctrl+V) onto the NEXT message. A ref mirrors it so `submit`
  // reads the latest set without going stale in its closure.
  const [attachments, setAttachments] = useState<ClipboardImage[]>([])
  const attachmentsRef = useRef<ClipboardImage[]>([])
  attachmentsRef.current = attachments
  const rawSupported = Boolean(useStdin().isRawModeSupported)

  const pickerOpen = loginPicker != null || modelPickerOpen || advisorPickerOpen

  // Ctrl+T collapses/expands child-thread bodies (the tree view stays; only
  // spawned threads' contents fold to their header lines).
  // Esc interrupts the in-flight turn (POST /interrupt aborts the run server-side).
  useInput(
    (input, key) => {
      if (pickerOpen) return // a picker owns the keys while open
      if (key.ctrl && (input === "t" || input === "T")) setThreadsCollapsed((v) => !v)
      if (key.escape && mode === "live" && state.status === "running") {
        const sid = sessionIdRef.current
        if (sid) void fetch(baseUrl + ROUTES.interrupt(sid), { method: "POST" }).catch(() => {})
      }
    },
    { isActive: rawSupported },
  )

  const apply = useCallback((ev: AgentEvent) => {
    setState((s) => reduce(s, ev))
    if (ev.type === "session.status") setStartedAt(ev.status === "running" ? Date.now() : null)
  }, [])

  // ---- live wiring: open the SSE stream BEFORE any message is sent ----
  useEffect(() => {
    if (mode !== "live") return
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(baseUrl + ROUTES.createSession, { method: "POST" })
        const { sessionId } = (await res.json()) as CreateSessionResponse
        sessionIdRef.current = sessionId
        const evRes = await fetch(baseUrl + ROUTES.events(sessionId))
        for await (const ev of readSSE(evRes)) {
          if (cancelled) break
          apply(ev)
        }
      } catch (err) {
        if (!cancelled) apply({ type: "error", message: `connect failed: ${String(err)}` })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [mode, baseUrl, apply])

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

  useEffect(() => {
    void refreshAdvisor()
  }, [refreshAdvisor])

  const submit = useCallback(
    async (text: string) => {
      const images = attachmentsRef.current
      setAttachments([]) // consume the pasted images with this message
      const shown = text || (images.length ? `📎 ${images.length} image${images.length === 1 ? "" : "s"}` : text)
      setState((s) => pushUser(s, shown))
      setStartedAt(Date.now())
      if (mode === "mock") {
        const gen = demo === "threads" ? mockThreadsRun(text) : mockRun(text)
        for await (const ev of gen) apply(ev)
        return
      }
      const id = sessionIdRef.current
      if (!id) {
        apply({ type: "error", message: "no live session yet" })
        return
      }
      try {
        await fetch(baseUrl + ROUTES.sendMessage(id), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(images.length ? { text, images } : { text }),
        })
      } catch (err) {
        apply({ type: "error", message: `send failed: ${String(err)}` })
      }
    },
    [mode, baseUrl, apply, demo],
  )

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
      printLine("Image paste needs the live server (run with --live).")
      return
    }
    const img = await grabClipboardImage()
    if (img) {
      setAttachments((a) => [...a, img])
      printLine("📎 image attached — type a message (optional) and press enter to send.")
    } else {
      printLine("No image on the clipboard. Copy an image (or screenshot), then press Ctrl+V.")
    }
  }, [mode, printLine])

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

  // /model — open the fuzzy model picker (provider → model → effort/speed).
  const doModel = useCallback(() => {
    if (mode !== "live") {
      printLine("The model picker needs the live server (run the server, then the TUI with --live).")
      return
    }
    setModelPickerOpen(true)
  }, [mode, printLine])

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

  const onCommand = useCallback(
    (name: string) => {
      switch (name) {
        case "/clear":
          setState(initialState)
          setStartedAt(null)
          break
        case "/quit":
          exit()
          break
        case "/help":
          printLine(
            "Commands: /clear, /help, /login, /model, /advisor, /quit. Type a message and press Enter to talk to the agent.",
          )
          break
        case "/login":
          void doLogin()
          break
        case "/model":
          doModel()
          break
        case "/advisor":
          doAdvisor()
          break
      }
    },
    [printLine, doLogin, doModel, doAdvisor, exit],
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
  // Grok-code-style status drawn into the input's bottom rule: the executor model
  // and effort, then the advisor's model and effort. "advisor: off" when there's
  // none; "(inactive)" when it's configured but suppressed (same model as executor).
  const effortParen = (e?: string | null) => (e ? ` (${e})` : "")
  const advisorPart =
    advisor && advisor.enabled && advisor.model
      ? ` · advisor: ${prettyModel(advisor.model)}${effortParen(advisor.effort)}${advisor.active ? "" : " (inactive)"}`
      : " · advisor: off"
  const bottomStatus =
    mode === "live"
      ? `${prettyModel(currentSel?.model)}${effortParen(currentSel?.effort)}${advisorPart}`
      : "mock"

  return (
    <Box flexDirection="column" width="100%">
      <WelcomeBanner mode={mode} cwd={cwd} model={bannerModel} />
      <Transcript state={state} collapsed={threadsCollapsed} />
      {running && startedAt != null && <StatusLine startedAt={startedAt} />}
      <Box flexDirection="column" width="100%" marginTop={1}>
        {loginPicker && <LoginPicker providers={loginPicker.providers} selected={loginPicker.selected} />}
        {modelPickerOpen && (
          <ModelPicker baseUrl={baseUrl} onDone={onModelDone} onCancel={() => setModelPickerOpen(false)} />
        )}
        {advisorPickerOpen && (
          <AdvisorPicker baseUrl={baseUrl} onDone={onAdvisorDone} onCancel={() => setAdvisorPickerOpen(false)} />
        )}
        <PromptInput
          disabled={running || pickerOpen}
          onSubmit={submit}
          onCommand={onCommand}
          status={bottomStatus}
          onPasteImage={onPasteImage}
          attachmentCount={attachments.length}
        />
        <Text dimColor>
          {"  / for commands · ctrl+v paste image · ctrl+c to quit"}
          {hasThreads ? "  ·  ctrl+t to " + (threadsCollapsed ? "expand" : "collapse") + " threads" : ""}
        </Text>
      </Box>
    </Box>
  )
}
