import { useEffect, useRef, useState } from "react"
import type { FormEvent } from "react"
import type { ModeSpec } from "@chunky/protocol"
import { applyOnboardingMode, fetchOnboarding, initiateLogin, loginStatus, saveCustomProvider, type OnboardingPayload, type OnboardingSuggestion } from "../lib/api"
import { openExternal } from "../lib/rpc"
import { sleep } from "../lib/sleep"

function specSummary(spec: ModeSpec): string {
  return [`Lead: ${spec.provider} / ${spec.model}`, spec.advisor ? `Advisor: ${spec.advisor.provider} / ${spec.advisor.model}` : "Advisor: off", spec.sidekick ? `Sidekick: ${spec.sidekick.provider} / ${spec.sidekick.model}` : "Sidekick: off"].join(" · ")
}

export function OnboardingWizard({ baseUrl, onClose, onApplied }: { baseUrl: string; onClose: () => void; onApplied: () => void }) {
  const [payload, setPayload] = useState<OnboardingPayload | null>(null)
  const [step, setStep] = useState<"connect" | "seats" | "finish" | "custom">("connect")
  const [selected, setSelected] = useState(0)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [custom, setCustom] = useState({ id: "", label: "", baseURL: "", key: "" })

  // Aborts the login poll below (Cancel button, or the wizard closing).
  const loginAbort = useRef<AbortController | null>(null)
  useEffect(() => { void fetchOnboarding(baseUrl).then(setPayload).catch((e) => setError((e as Error).message)) }, [baseUrl])
  useEffect(() => { const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose() }; document.addEventListener("keydown", onKey); return () => document.removeEventListener("keydown", onKey) }, [onClose])
  // Closing the wizard must not leave a 150s poll running in the background.
  useEffect(() => () => loginAbort.current?.abort(), [])
  const providers = payload?.providers ?? []
  const suggestions = payload?.suggestedModes ?? []
  const login = async (id: string) => {
    loginAbort.current?.abort()
    const ac = new AbortController()
    loginAbort.current = ac
    setBusy(id); setError(null)
    try {
      const init = await initiateLogin(baseUrl, id)
      if (init.kind === "url") { if (!(await openExternal(init.url))) setError(`Open this URL to sign in: ${init.url}`) }
      // Poll until the loopback callback lands, the deadline passes, or Cancel.
      if (init.kind !== "ready") for (let until = Date.now() + 150000; Date.now() < until && !ac.signal.aborted; ) { await sleep(2000, ac.signal); if (ac.signal.aborted) break; if (await loginStatus(baseUrl, id)) break }
      if (ac.signal.aborted) return
      setPayload(await fetchOnboarding(baseUrl))
    } catch (e) { if (!ac.signal.aborted) setError((e as Error).message) } finally { if (loginAbort.current === ac) loginAbort.current = null; setBusy(null) }
  }
  const submitCustom = async (e: FormEvent) => { e.preventDefault(); if (Object.values(custom).some((v) => !v.trim())) { setError("All fields are required."); return }; setBusy("custom"); setError(null); try { await saveCustomProvider(baseUrl, custom); setPayload(await fetchOnboarding(baseUrl)); setCustom({ id: "", label: "", baseURL: "", key: "" }); setStep("connect") } catch (err) { setError((err as Error).message) } finally { setBusy(null) } }
  const apply = async () => { const s = suggestions[selected]; if (!s) { setStep("finish"); return }; setBusy("apply"); setError(null); try { await applyOnboardingMode(baseUrl, s.spec, s.name); onApplied(); setStep("finish") } catch (e) { setError((e as Error).message) } finally { setBusy(null) } }
  return <div className="chunky-onboarding-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}><section className="chunky-onboarding" role="dialog" aria-modal="true" aria-labelledby="onboarding-title">
    <button className="chunky-onboarding-close" onClick={onClose} aria-label="Close">×</button>
    {!payload ? <div className="chunky-onboarding-loading">Loading onboarding…</div> : step === "custom" ? <form onSubmit={(e) => void submitCustom(e)}><h2 id="onboarding-title">Add a custom provider</h2><p className="chunky-onboarding-muted">Any OpenAI-compatible endpoint can be added.</p>{([["id","Provider ID"],["label","Display label"],["baseURL","Base URL"],["key","API key"]] as const).map(([key, label]) => <label className="chunky-onboarding-field" key={key}>{label}<input required type={key === "key" ? "password" : "text"} value={custom[key]} onChange={(e) => setCustom({ ...custom, [key]: e.target.value })} placeholder={key === "baseURL" ? "https://…/v1" : undefined} /></label>)}{error && <p className="chunky-onboarding-error">{error}</p>}<div className="chunky-onboarding-actions"><button type="button" onClick={() => { setStep("connect"); setError(null) }}>Cancel</button><button className="chunky-onboarding-primary" disabled={busy === "custom"}>{busy === "custom" ? "Saving…" : "Add provider"}</button></div></form> : step === "connect" ? <><h2 id="onboarding-title">Welcome to Chunky</h2><p className="chunky-onboarding-muted">Connect a provider to get the most from your workspace.</p><div className="chunky-onboarding-list">{providers.map((p) => <div className="chunky-onboarding-provider" key={p.id}><div><strong>{p.label}</strong><small>{p.id}</small></div><span className={`chunky-onboarding-pill ${p.status}`}>{p.status === "inherited" ? "Inherited from Claude Code" : p.status === "missing" ? "Not connected" : "Connected ✓"}</span>{p.status === "missing" && (busy === p.id ? <button className="chunky-onboarding-cancel" onClick={() => loginAbort.current?.abort()} title="Stop waiting for the browser sign-in">Waiting for browser… ×</button> : <button onClick={() => void login(p.id)} disabled={busy !== null}>Connect</button>)}</div>)}</div><button className="chunky-onboarding-link" onClick={() => setStep("custom")}>＋ Add custom provider…</button>{error && <p className="chunky-onboarding-error">{error}</p>}<div className="chunky-onboarding-actions"><button onClick={onClose}>Skip</button><button className="chunky-onboarding-primary" disabled={!suggestions.length} onClick={() => { setSelected(0); setStep("seats") }}>{suggestions.length ? "Continue" : "Skip for now"}</button></div></> : step === "seats" ? <><h2 id="onboarding-title">Choose a suggested setup</h2><p className="chunky-onboarding-muted">You can change these choices later.</p><div className="chunky-onboarding-cards">{suggestions.map((s: OnboardingSuggestion, i) => <button className={`chunky-onboarding-card ${i === selected ? "selected" : ""}`} key={s.name} onClick={() => setSelected(i)}><strong>{s.name}</strong><span>{s.description}</span><small>{specSummary(s.spec)}</small></button>)}</div>{error && <p className="chunky-onboarding-error">{error}</p>}<div className="chunky-onboarding-actions"><button onClick={() => setStep("finish")}>Skip setup</button><button className="chunky-onboarding-primary" disabled={busy === "apply"} onClick={() => void apply()}>{busy === "apply" ? "Applying…" : "Apply setup"}</button></div></> : <><h2 id="onboarding-title">You’re all set</h2><p className="chunky-onboarding-muted">Your provider setup is ready. Say hi to start building.</p><div className="chunky-onboarding-actions"><button onClick={onClose}>Not now</button><button className="chunky-onboarding-primary" onClick={onClose}>Finish</button></div>{error && <p className="chunky-onboarding-error">{error}</p>}</>}
  </section></div>
}
