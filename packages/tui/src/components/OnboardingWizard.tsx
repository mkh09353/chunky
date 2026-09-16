import { ThemeText } from "./ThemeText.js"
import { useEffect, useRef, useState } from "react"
import { TextAttributes } from "@opentui/core"
import { useInput, usePasteText } from "../useInput.js"
import { ACCENT, WARNING } from "../theme.js"
import type { ModeSpec } from "@chunky/protocol"

type Provider = { id: string; label: string; status: string; detail?: string }
type Suggestion = { name: string; description: string; spec: ModeSpec; locked?: boolean }
type Payload = { providers?: Provider[]; suggestedModes?: Suggestion[]; onboardedAt?: number }

export function OnboardingWizard({ baseUrl, onDone, onLogin }: { baseUrl: string; onDone: (stamped: boolean) => void; onLogin?: (provider: { id: string; label: string; ready: boolean }) => Promise<boolean> }) {
  const [payload, setPayload] = useState<Payload | null>(null)
  const [step, setStep] = useState<"connect" | "seats" | "finish" | "custom" | "telnyx-key">("connect")
  const [apiKey, setApiKey] = useState("")
  const [selected, setSelected] = useState(0)
  const [field, setField] = useState(0)
  const [values, setValues] = useState<string[]>(["", "", "", ""])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone
  const suggestions = (payload?.suggestedModes ?? []).filter((suggestion) => !suggestion.locked)
  useEffect(() => {
    let cancelled = false
    fetch(baseUrl + "/api/onboarding")
      .then((r) => { if (!r.ok) throw new Error("Could not load setup"); return r.json() })
      .then((next) => { if (!cancelled) setPayload(next) })
      .catch(() => { if (!cancelled) onDoneRef.current(false) })
    return () => { cancelled = true }
  }, [baseUrl])
  async function saveTelnyxKey() {
    if (!apiKey.trim() || busy) return
    setBusy(true)
    setError(undefined)
    let saved = false
    try {
      const response = await fetch(baseUrl + "/api/providers/telnyx/key", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: apiKey.trim() }), signal: AbortSignal.timeout(15_000),
      })
      if (!response.ok) throw new Error("Could not verify the Telnyx key. Check your key, account permissions, and connection, then retry.")
      saved = true
      setApiKey("")
      const refreshed = await fetch(baseUrl + "/api/onboarding", { signal: AbortSignal.timeout(10_000) })
      if (!refreshed.ok) throw new Error("Key saved, but setup could not refresh. Press Esc and reopen /onboard.")
      setPayload(await refreshed.json())
      setStep("connect")
    } catch {
      setError(saved
        ? "Key saved, but setup could not refresh. Press Esc and reopen /onboard."
        : "Could not complete Telnyx setup. Check your API key and connection, then retry.")
    } finally { setBusy(false) }
  }
  usePasteText((text) => setApiKey((key) => key + text.replace(/[\r\n]/g, "")), { isActive: step === "telnyx-key" && !busy })
  useInput((_, key) => {
    if (step === "telnyx-key") {
      if (busy) return
      if (key.escape) { setApiKey(""); setError(undefined); setStep("connect"); return }
      if (key.return) { void saveTelnyxKey(); return }
      if (key.backspace || key.delete) { setApiKey((value) => value.slice(0, -1)); return }
      if (_ && !key.ctrl && !key.meta) setApiKey((value) => value + _)
      return
    }
    if (key.escape) return onDone(false)
    if (step === "custom") {
      if (key.return) {
        if (field < 3) return setField(field + 1)
        const [id, label, baseURL, apiKey] = values
        if (!id || !label || !baseURL || !apiKey) return
        void fetch(baseUrl + "/api/providers/custom", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, label, baseURL, key: apiKey }) }).then(() => fetch(baseUrl + "/api/onboarding")).then((r) => r.json()).then((next) => { setPayload(next); setStep("connect"); setValues(["", "", "", ""]); setField(0) })
        return
      }
      if (key.backspace) return setValues((v) => v.map((x, i) => i === field ? x.slice(0, -1) : x))
      if (_.length > 0 && !key.ctrl && !key.meta) setValues((v) => v.map((x, i) => i === field ? x + _ : x))
      return
    }
    if (key.upArrow || key.downArrow) {
      const last = step === "seats" ? Math.max(0, suggestions.length - 1) : (payload?.providers?.length ?? 0)
      setSelected((n) => Math.max(0, Math.min(last, n + (key.upArrow ? -1 : 1))))
    }
    if (_ === "c" && step === "connect") return setStep("custom")
    if (key.return && step === "connect") {
      const rows = payload?.providers ?? []
      if (selected < rows.length) {
        const p = rows[selected]
        if (p?.id === "telnyx") { setApiKey(""); setError(undefined); setStep("telnyx-key"); return }
        if (p?.status === "missing" && (p.id === "codex" || p.id === "grok") && onLogin && !busy) {
          setBusy(true); setError(undefined)
          void onLogin({ id: p.id, label: p.label, ready: false }).then(async (ok) => {
            if (ok) { const next = await fetch(baseUrl + "/api/onboarding"); setPayload(await next.json()) }
            else setError(`Login for ${p.id} was not completed.`)
          }).catch(() => setError(`Login for ${p.id} failed.`)).finally(() => setBusy(false))
        }
        return
      }
      setSelected(0)
      setStep(suggestions.length > 0 ? "seats" : "finish")
      return
    }
    else if (key.return && step === "seats") {
      const suggestion = suggestions[selected]
      if (suggestion) void fetch(baseUrl + "/api/onboarding/apply", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: suggestion.spec, name: suggestion.name }) }).then(() => setStep("finish"))
      else setStep("finish")
    } else if (key.return && step === "finish") void fetch(baseUrl + "/api/onboarding/complete", { method: "POST" }).then(() => onDone(true))
  }, { isActive: true })
  if (!payload) return <box><ThemeText>Connecting to onboarding… (Esc to cancel)</ThemeText></box>
  if (step === "telnyx-key") return <box flexDirection="column">
    <ThemeText fg={ACCENT}>Connect Telnyx</ThemeText>
    <ThemeText>Paste your API key from portal.telnyx.com. Models refresh from your account.</ThemeText>
    <ThemeText>API key: {"•".repeat(apiKey.length)}▌</ThemeText>
    {error && <ThemeText fg={WARNING}>{error}</ThemeText>}
    <ThemeText>{busy ? "Verifying API key…" : "Enter saves · Esc back"}</ThemeText>
  </box>
  if (step === "custom") { const labels = ["id", "label", "baseURL", "API key"]; return <box flexDirection="column"><ThemeText fg={ACCENT}>Custom OpenAI-compatible provider</ThemeText><ThemeText>{labels[field]}: {field === 3 ? "•".repeat(values[field].length) : values[field]}▌</ThemeText><ThemeText>Enter advances · Esc cancels</ThemeText></box> }
  if (step === "connect") { const rows = payload.providers ?? []; return <box flexDirection="column"><ThemeText attributes={TextAttributes.BOLD} fg={ACCENT}>Welcome to Chunky — connect a provider</ThemeText>{rows.map((p, i) => <ThemeText key={p.id} fg={i === selected ? ACCENT : undefined}>{i === selected ? "❯ " : "  "}{p.status === "missing" ? "✗" : "✓"} {p.label}{p.status === "inherited" ? " (inherited from Claude Code)" : ""}</ThemeText>)}<ThemeText fg={selected === rows.length ? ACCENT : undefined}>{selected === rows.length ? "❯ " : "  "}Continue</ThemeText>{busy && <ThemeText>Waiting for login…</ThemeText>}{error && <ThemeText fg={WARNING}>{error}</ThemeText>}<ThemeText>↑/↓ choose · Enter select · c custom provider · Esc to leave</ThemeText></box> }
  if (step === "seats") return <box flexDirection="column"><ThemeText attributes={TextAttributes.BOLD} fg={ACCENT}>Choose a suggested setup</ThemeText>{suggestions.map((s, i) => <ThemeText key={s.name} fg={i === selected ? ACCENT : undefined}>{i === selected ? "❯ " : "  "}{s.name} — {s.description}</ThemeText>)}<ThemeText>Enter to apply · Esc to cancel</ThemeText></box>
  return <box flexDirection="column"><ThemeText attributes={TextAttributes.BOLD} fg={ACCENT}>You're set!</ThemeText><ThemeText>Try /model, /mode, /login, or /onboard. Say hi to test it.</ThemeText><ThemeText>Enter to finish · Esc to leave</ThemeText></box>
}
