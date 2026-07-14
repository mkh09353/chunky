import { useEffect, useState } from "react"
import { TextAttributes } from "@opentui/core"
import { useInput } from "../useInput.js"
import { ACCENT, WARNING } from "../theme.js"
import type { ModeSpec } from "@chunky/protocol"

type Provider = { id: string; label: string; status: string; detail?: string }
type Suggestion = { name: string; description: string; spec: ModeSpec }
type Payload = { providers?: Provider[]; suggestedModes?: Suggestion[]; onboardedAt?: number }

export function OnboardingWizard({ baseUrl, onDone, onLogin }: { baseUrl: string; onDone: (stamped: boolean) => void; onLogin?: (provider: { id: string; label: string; ready: boolean }) => Promise<boolean> }) {
  const [payload, setPayload] = useState<Payload | null>(null)
  const [step, setStep] = useState<"connect" | "seats" | "finish" | "custom">("connect")
  const [selected, setSelected] = useState(0)
  const [field, setField] = useState(0)
  const [values, setValues] = useState<string[]>(["", "", "", ""])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  useEffect(() => { fetch(baseUrl + "/api/onboarding").then((r) => r.json()).then(setPayload).catch(() => onDone(false)) }, [baseUrl, onDone])
  useInput((_, key) => {
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
    if (key.upArrow || key.downArrow) setSelected((n) => Math.max(0, Math.min((payload?.providers?.length ?? 0), n + (key.upArrow ? -1 : 1))))
    if (_ === "c" && step === "connect") return setStep("custom")
    if (key.return && step === "connect") {
      const rows = payload?.providers ?? []
      if (selected < rows.length) {
        const p = rows[selected]
        if (p?.status === "missing" && (p.id === "codex" || p.id === "grok") && onLogin && !busy) {
          setBusy(true); setError(undefined)
          void onLogin({ id: p.id, label: p.label, ready: false }).then(async (ok) => {
            if (ok) { const next = await fetch(baseUrl + "/api/onboarding"); setPayload(await next.json()) }
            else setError(`Login for ${p.id} was not completed.`)
          }).catch(() => setError(`Login for ${p.id} failed.`)).finally(() => setBusy(false))
        }
        return
      }
      if ((payload?.suggestedModes?.length ?? 0) > 0) setStep("seats")
      return
    }
    else if (key.return && step === "seats") {
      const suggestion = payload?.suggestedModes?.[selected]
      if (suggestion) void fetch(baseUrl + "/api/onboarding/apply", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: suggestion.spec, name: suggestion.name }) }).then(() => setStep("finish"))
      else setStep("finish")
    } else if (key.return && step === "finish") void fetch(baseUrl + "/api/onboarding/complete", { method: "POST" }).then(() => onDone(true))
  }, { isActive: true })
  if (!payload) return <box><text>Connecting to onboarding… (Esc to cancel)</text></box>
  if (step === "custom") { const labels = ["id", "label", "baseURL", "API key"]; return <box flexDirection="column"><text fg={ACCENT}>Custom OpenAI-compatible provider</text><text>{labels[field]}: {field === 3 ? "•".repeat(values[field].length) : values[field]}▌</text><text>Enter advances · Esc cancels</text></box> }
  if (step === "connect") { const rows = payload.providers ?? []; return <box flexDirection="column"><text attributes={TextAttributes.BOLD} fg={ACCENT}>Welcome to Chunky — connect a provider</text>{rows.map((p, i) => <text key={p.id} fg={i === selected ? ACCENT : undefined}>{i === selected ? "❯ " : "  "}{p.status === "missing" ? "✗" : "✓"} {p.label}{p.status === "inherited" ? " (inherited from Claude Code)" : ""}</text>)}<text fg={selected === rows.length ? ACCENT : undefined}>{selected === rows.length ? "❯ " : "  "}Continue</text>{busy && <text>Waiting for login…</text>}{error && <text fg={WARNING}>{error}</text>}<text>↑/↓ choose · Enter select · c custom provider · Esc to leave</text></box> }
  const suggestions = payload.suggestedModes ?? []
  if (step === "seats") return <box flexDirection="column"><text attributes={TextAttributes.BOLD} fg={ACCENT}>Choose a suggested setup</text>{suggestions.map((s, i) => <text key={s.name} fg={i === selected ? ACCENT : undefined}>{i === selected ? "❯ " : "  "}{s.name} — {s.description}</text>)}<text>Enter to apply · Esc to cancel</text></box>
  return <box flexDirection="column"><text attributes={TextAttributes.BOLD} fg={ACCENT}>You're set!</text><text>Try /model, /mode, /login, or /onboard. Say hi to test it.</text><text>Enter to finish · Esc to leave</text></box>
}
