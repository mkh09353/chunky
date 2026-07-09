import React, { useCallback, useEffect, useRef, useState } from "react"
import { Box, Text, useApp } from "ink"
import { ROUTES, readSSE, type AgentEvent, type CreateSessionResponse } from "@mc/protocol"
import { mockRun } from "@mc/protocol/mock"
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
}

export function App({ mode, baseUrl, cwd, autoDemo = true }: Props) {
  const { exit } = useApp()
  const [state, setState] = useState<TranscriptState>(initialState)
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const sessionIdRef = useRef<string | null>(null)

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
        for await (const ev of mockRun(text)) apply(ev)
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
    [mode, baseUrl, apply],
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
          apply({ type: "message.start", role: "assistant" })
          apply({
            type: "message.delta",
            text: "Commands: /clear, /help, /model, /quit. Type a message and press Enter to talk to the agent.",
          })
          apply({ type: "message.end" })
          break
        case "/model":
          apply({ type: "message.start", role: "assistant" })
          apply({ type: "message.delta", text: "Model switching is cosmetic in this prototype (single Zen model)." })
          apply({ type: "message.end" })
          break
      }
    },
    [apply, exit],
  )

  // Mock demo turn so the transcript streams even without a TTY.
  useEffect(() => {
    if (mode === "mock" && autoDemo) {
      const t = setTimeout(() => void submit("scaffold a Claude Code style TUI"), 300)
      return () => clearTimeout(t)
    }
  }, [mode, autoDemo, submit])

  const running = state.status === "running"

  return (
    <Box flexDirection="column">
      <WelcomeBanner mode={mode} cwd={cwd} />
      <Transcript items={state.items} />
      {running && startedAt != null && <StatusLine startedAt={startedAt} />}
      <Box marginTop={1}>
        <PromptInput disabled={running} onSubmit={submit} onCommand={onCommand} />
      </Box>
      {running && (
        <Box paddingX={1}>
          <Text color={ACCENT} dimColor>
            agent is working…
          </Text>
        </Box>
      )}
    </Box>
  )
}
