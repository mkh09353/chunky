import React, { useCallback, useEffect, useRef, useState } from "react"
import { Box, Text, useApp, useInput, useStdin } from "ink"
import { ROUTES, readSSE, type AgentEvent, type CreateSessionResponse } from "@mc/protocol"
import { mockRun } from "@mc/protocol/mock"
import { mockThreadsRun } from "./mockThreads.js"
import { initialState, pushUser, reduce, type TranscriptState } from "./transcript.js"
import { WelcomeBanner } from "./components/WelcomeBanner.js"
import { Transcript } from "./components/Transcript.js"
import { StatusLine } from "./components/StatusLine.js"
import { PromptInput } from "./components/PromptInput.js"
import { ACCENT } from "./theme.js"

interface Props {
  mode: "mock" | "live"
  baseUrl: string
  cwd: string
  /** In mock mode, auto-run one demo turn on mount (lets the UI stream with no TTY). */
  autoDemo?: boolean
  /** Which mock generator the auto-demo drives ("threads" shows the nested-thread view). */
  demo?: "basic" | "threads"
}

export function App({ mode, baseUrl, cwd, autoDemo = true, demo = "basic" }: Props) {
  const { exit } = useApp()
  const [state, setState] = useState<TranscriptState>(initialState)
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [threadsCollapsed, setThreadsCollapsed] = useState(false)
  const sessionIdRef = useRef<string | null>(null)
  const rawSupported = Boolean(useStdin().isRawModeSupported)

  // Ctrl+T collapses/expands child-thread bodies (the tree view stays; only
  // spawned threads' contents fold to their header lines).
  useInput(
    (input, key) => {
      if (key.ctrl && (input === "t" || input === "T")) setThreadsCollapsed((v) => !v)
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

  const submit = useCallback(
    async (text: string) => {
      setState((s) => pushUser(s, text))
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
          body: JSON.stringify({ text }),
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

  interface ProviderRow {
    id: string
    label: string
    ready: boolean
    active: boolean
  }

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

  // /login — list providers and initiate a login for the first not-yet-ready one.
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
    const list = providers
      .map((p) => `  ${p.active ? "●" : "○"} ${p.id} — ${p.label} ${p.ready ? "[ready]" : "[login needed]"}`)
      .join("\n")
    const target = providers.find((p) => !p.ready) ?? providers.find((p) => p.id !== "zen")
    if (!target) {
      printLine(`Providers:\n${list}\n\nAll providers are already logged in.`)
      return
    }
    try {
      const res = await fetch(baseUrl + `/api/auth/${target.id}/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ method: "device" }),
      })
      const body = (await res.json()) as { url?: string; userCode?: string; instructions?: string; error?: string }
      if (body.error) {
        printLine(`Providers:\n${list}\n\nLogin for ${target.id} failed: ${body.error}`)
        return
      }
      const codeLine = body.userCode ? `\n  Code: ${body.userCode}` : ""
      printLine(
        `Providers:\n${list}\n\nLogging in to ${target.id}:\n  ${body.instructions ?? body.url ?? ""}` +
          `${codeLine}\n  URL: ${body.url ?? ""}\n\nAfter authorizing, run /model to select it.`,
      )
    } catch (err) {
      printLine(`Login request failed: ${String(err)}`)
    }
  }, [mode, baseUrl, fetchProviders, printLine])

  // /model — cycle the active provider to the next registered one and select it.
  const doModel = useCallback(async () => {
    if (mode !== "live") {
      printLine("Provider switching needs the live server (run with --live).")
      return
    }
    const providers = await fetchProviders()
    if (providers.length === 0) {
      printLine("No providers available (is the server running?).")
      return
    }
    const activeIdx = Math.max(
      0,
      providers.findIndex((p) => p.active),
    )
    const next = providers[(activeIdx + 1) % providers.length]!
    try {
      const res = await fetch(baseUrl + `/api/providers/${next.id}/select`, { method: "POST" })
      const body = (await res.json()) as { active?: string; error?: string }
      if (body.error) {
        printLine(`Could not select ${next.id}: ${body.error}`)
        return
      }
      const list = providers
        .map((p) => `  ${p.id === next.id ? "●" : "○"} ${p.id} — ${p.label}${p.ready ? "" : " [login needed]"}`)
        .join("\n")
      printLine(
        `Active provider → ${next.id}\n${list}\n\n` +
          `Note: this takes effect for models built after selection; restart the server if the agent was already built.`,
      )
    } catch (err) {
      printLine(`Select request failed: ${String(err)}`)
    }
  }, [mode, baseUrl, fetchProviders, printLine])

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
            "Commands: /clear, /help, /login, /model, /quit. Type a message and press Enter to talk to the agent.",
          )
          break
        case "/login":
          void doLogin()
          break
        case "/model":
          void doModel()
          break
      }
    },
    [printLine, doLogin, doModel, exit],
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

  return (
    <Box flexDirection="column" width="100%">
      <WelcomeBanner mode={mode} cwd={cwd} />
      <Transcript state={state} collapsed={threadsCollapsed} />
      {running && startedAt != null && <StatusLine startedAt={startedAt} />}
      <Box flexDirection="column" width="100%" marginTop={1}>
        <Box width="100%" justifyContent="flex-end">
          <Text dimColor>
            <Text color={ACCENT}>●</Text> {mode === "live" ? "glm-5.2" : "mock"} · /model
          </Text>
        </Box>
        <PromptInput disabled={running} onSubmit={submit} onCommand={onCommand} />
        <Text dimColor>
          {"  ? for shortcuts · / for commands · ctrl+c to quit"}
          {hasThreads ? "  ·  ctrl+t to " + (threadsCollapsed ? "expand" : "collapse") + " threads" : ""}
        </Text>
      </Box>
    </Box>
  )
}
