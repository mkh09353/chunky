import { useEffect, useState } from "react"
import { TextAttributes } from "@opentui/core"
import { ACCENT, BORDER, ERROR } from "../theme.js"
import { rawModeSupported, useInput } from "../useInput.js"

interface Provider { id: string; label: string; ready: boolean }
interface Model { id: string; name: string; custom?: boolean }
interface Props { baseUrl: string; onDone: (summary: string) => void; onCancel: () => void }
const WINDOW = 10

export function toggleModel(selected: Set<string>, id: string): Set<string> {
  const next = new Set(selected)
  next.has(id) ? next.delete(id) : next.add(id)
  return next
}

export function ProviderPicker({ baseUrl, onDone, onCancel }: Props) {
  const [providers, setProviders] = useState<Provider[]>([])
  const [models, setModels] = useState<Model[]>([])
  const [selected, setSelected] = useState(new Set<string>())
  const [provider, setProvider] = useState<Provider | null>(null)
  const [sel, setSel] = useState(0)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void fetch(baseUrl + "/api/providers").then((r) => r.json()).then((body: { providers?: Provider[]; error?: string }) => {
      if (body.error) throw new Error(body.error)
      if (!cancelled) { setProviders(body.providers ?? []); setLoading(false) }
    }).catch((err) => { if (!cancelled) { setError(String(err)); setLoading(false) } })
    return () => { cancelled = true }
  }, [baseUrl])

  async function choose(p: Provider) {
    setLoading(true); setError(null)
    try {
      const r = await fetch(`${baseUrl}/api/providers/${encodeURIComponent(p.id)}/models/availability`)
      const body = await r.json() as { models?: Model[]; available?: string[]; error?: string }
      if (!r.ok || body.error) throw new Error(body.error ?? `HTTP ${r.status}`)
      setProvider(p); setModels(body.models ?? []); setSelected(new Set(body.available ?? [])); setSel(0)
    } catch (err) { setError(String(err)) } finally { setLoading(false) }
  }

  async function save() {
    if (!provider) return
    setBusy(true); setError(null)
    try {
      const r = await fetch(`${baseUrl}/api/providers/${encodeURIComponent(provider.id)}/models/availability`, {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ available: models.map((m) => m.id).filter((id) => selected.has(id)) }),
      })
      const body = await r.json() as { error?: string }
      if (!r.ok || body.error) throw new Error(body.error ?? `HTTP ${r.status}`)
      onDone(`${provider.id}: ${selected.size} of ${models.length} models available.`)
    } catch (err) { setError(String(err)); setBusy(false) }
  }

  useInput((_input, key) => {
    if (loading || busy) return
    const count = provider ? models.length : providers.length
    if (key.escape) {
      if (provider) { setProvider(null); setModels([]); setSel(0); setError(null) } else onCancel()
      return
    }
    if (key.upArrow) return setSel((s) => Math.max(0, s - 1))
    if (key.downArrow) return setSel((s) => Math.min(Math.max(0, count - 1), s + 1))
    if (provider && _input === " ") {
      const model = models[sel]; if (model) setSelected((s) => toggleModel(s, model.id)); return
    }
    if (key.return) { if (provider) void save(); else { const p = providers[sel]; if (p) void choose(p) } }
  }, { isActive: rawModeSupported })

  const rows = provider ? models : providers
  const start = Math.max(0, Math.min(sel - Math.floor(WINDOW / 2), Math.max(0, rows.length - WINDOW)))
  return <box flexDirection="column" border borderStyle="rounded" borderColor={BORDER} paddingX={1} marginBottom={1}>
    <text attributes={TextAttributes.DIM}>{provider ? `${provider.id} models — ↑/↓ move · space toggle · enter save · esc back` : "Configure provider models — ↑/↓ move · enter select · esc cancel"}</text>
    {loading ? <text attributes={TextAttributes.DIM}>Loading…</text> : rows.length === 0 ? <text attributes={TextAttributes.DIM}>No models available.</text> : rows.slice(start, start + WINDOW).map((row, i) => {
      const index = start + i, on = index === sel
      return <box key={row.id} flexDirection="row"><text fg={on ? ACCENT : undefined}>{on ? "❯ " : "  "}</text>
        {provider && <text>{selected.has(row.id) ? "[x] " : "[ ] "}</text>}
        <text fg={on ? ACCENT : undefined} attributes={on ? TextAttributes.BOLD : 0}>{row.id}</text>
        <text attributes={TextAttributes.DIM}>{provider ? ` — ${(row as Model).name}${(row as Model).custom ? " [custom]" : ""}` : ` — ${(row as Provider).label}${(row as Provider).ready ? " [logged in]" : ""}`}</text>
      </box>
    })}
    {error && <text fg={ERROR}>{error}</text>}
    {busy && <text attributes={TextAttributes.DIM}>Saving…</text>}
  </box>
}
