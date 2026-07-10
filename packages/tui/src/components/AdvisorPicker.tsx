import React, { useEffect, useMemo, useState } from "react"
import { Box, Text, useInput, useStdin } from "ink"
import figures from "figures"
import { ACCENT, BORDER } from "../theme.js"

// ---- types mirrored from the server (kept local to avoid a server import) ----
export interface ModelInfo {
  id: string
  name: string
  reasoning: boolean
  contextLimit?: number
}
type Effort = "low" | "medium" | "high" | "xhigh"

interface Row {
  provider: string
  ready: boolean
  model: ModelInfo
}

export interface AdvisorSelectionResult {
  enabled: boolean
  provider?: string
  model?: string
  effort?: Effort
}

interface Props {
  baseUrl: string
  onDone: (result: AdvisorSelectionResult, summary: string) => void
  onCancel: () => void
}

const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh"]
const WINDOW = 10 // visible rows in the scrolling list

/** Case-insensitive subsequence fuzzy match (same scorer as ModelPicker). */
function fuzzyScore(query: string, target: string): number {
  if (!query) return 0
  const q = query.toLowerCase()
  const t = target.toLowerCase()
  let ti = 0
  let score = 0
  let streak = 0
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi]!
    const found = t.indexOf(c, ti)
    if (found === -1) return -1
    if (found === ti) streak += 1
    else streak = 0
    score += 10 - Math.min(9, found - ti) + streak * 3
    ti = found + 1
  }
  return score
}

/**
 * The advisor picker opened by /advisor. Sets the model that backs the always-on
 * Advisor side-thread (the executor consults it via the `advisor` tool). A
 * synthetic "Turn advisor OFF" row sits at the top of the list; reasoning models
 * get an effort sub-picker. POSTs to /api/advisor. Mirrors ModelPicker's style;
 * unlike it, there's no speed step and the config is {enabled, provider, model,
 * effort}. The server auto-suppresses an advisor that equals the executor model —
 * we surface that as an "(inactive)" note.
 */
export function AdvisorPicker({ baseUrl, onDone, onCancel }: Props) {
  const rawSupported = Boolean(useStdin().isRawModeSupported)
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [filter, setFilter] = useState("")
  const [step, setStep] = useState<"list" | "effort">("list")
  const [listSel, setListSel] = useState(0)
  const [optSel, setOptSel] = useState(0)
  const [chosen, setChosen] = useState<Row | null>(null)

  // Fetch every provider's models on mount and flatten to provider/model rows.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const provRes = await fetch(baseUrl + "/api/providers")
        const provBody = (await provRes.json()) as {
          providers?: Array<{ id: string; ready: boolean }>
        }
        const providers = provBody.providers ?? []
        const all: Row[] = []
        for (const p of providers) {
          try {
            const r = await fetch(baseUrl + `/api/providers/${p.id}/models`)
            const b = (await r.json()) as { models?: ModelInfo[] }
            for (const m of b.models ?? []) all.push({ provider: p.id, ready: p.ready, model: m })
          } catch {
            // skip a provider whose models can't be listed
          }
        }
        if (!cancelled) {
          setRows(all)
          setLoading(false)
        }
      } catch (err) {
        if (!cancelled) {
          setError(String(err))
          setLoading(false)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [baseUrl])

  // Filter + rank rows against the current query.
  const filtered = useMemo(() => {
    if (!filter) return rows
    return rows
      .map((row) => ({ row, s: fuzzyScore(filter, `${row.provider}/${row.model.id} ${row.model.name}`) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.row)
  }, [rows, filter])

  // Items = a synthetic OFF row (index 0) followed by the filtered model rows.
  const items = useMemo<Array<{ off: true } | { off: false; row: Row }>>(
    () => [{ off: true }, ...filtered.map((row) => ({ off: false as const, row }))],
    [filtered],
  )

  // Keep the selection in-bounds when the filter narrows the list.
  useEffect(() => {
    setListSel((s) => Math.min(s, Math.max(0, items.length - 1)))
  }, [items.length])

  async function post(payload: AdvisorSelectionResult, describe: string) {
    setBusy(true)
    try {
      const res = await fetch(baseUrl + "/api/advisor", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      })
      const body = (await res.json()) as { error?: string; active?: boolean }
      if (body.error) {
        onDone(payload, `Could not update advisor: ${body.error}`)
        return
      }
      let note = ""
      if (payload.enabled && body.active === false) {
        note =
          "\n(note: that's the same model as your executor, so the advisor stays inactive — pick a different model.)"
      } else if (payload.enabled) {
        const row = rows.find((r) => r.provider === payload.provider && r.model.id === payload.model)
        if (row && !row.ready) note = `\n(note: ${payload.provider} isn't logged in yet — run /login to authorize it.)`
      }
      onDone(payload, `${describe}${note}`)
    } catch (err) {
      onDone(payload, `Advisor request failed: ${String(err)}`)
    }
  }

  function submitModel(row: Row, eff?: Effort) {
    const payload: AdvisorSelectionResult = {
      enabled: true,
      provider: row.provider,
      model: row.model.id,
      ...(eff ? { effort: eff } : {}),
    }
    const bits = [`${row.provider}/${row.model.id}`]
    if (eff) bits.push(`effort ${eff}`)
    void post(payload, `Advisor → ${bits.join(" · ")}`)
  }

  useInput(
    (input, key) => {
      if (busy || loading) return

      // ---- effort sub-picker (reasoning models only) ----
      if (step === "effort") {
        if (key.escape) {
          setStep("list")
          return
        }
        if (key.upArrow) return setOptSel((s) => (s - 1 + EFFORTS.length) % EFFORTS.length)
        if (key.downArrow) return setOptSel((s) => (s + 1) % EFFORTS.length)
        if (key.return && chosen) submitModel(chosen, EFFORTS[optSel]!)
        return
      }

      // ---- list (OFF row + models) ----
      if (key.escape) return onCancel()
      if (key.upArrow) return setListSel((s) => Math.max(0, s - 1))
      if (key.downArrow) return setListSel((s) => Math.min(Math.max(0, items.length - 1), s + 1))
      if (key.return) {
        const item = items[listSel]
        if (!item) return
        if (item.off) {
          void post({ enabled: false }, "Advisor → off")
          return
        }
        if (item.row.model.reasoning) {
          setChosen(item.row)
          setOptSel(0)
          setStep("effort")
        } else {
          submitModel(item.row)
        }
        return
      }
      if (key.backspace || key.delete) {
        setFilter((f) => f.slice(0, -1))
        setListSel((s) => (s === 0 ? 0 : 1))
        return
      }
      // printable characters extend the filter; default the cursor to the first model
      if (input && !key.ctrl && !key.meta) {
        setFilter((f) => f + input)
        setListSel(1)
      }
    },
    { isActive: rawSupported },
  )

  // ---- render ----
  if (loading) {
    return (
      <Box borderStyle="round" borderColor={BORDER} paddingX={1} marginBottom={1}>
        <Text dimColor>Loading models…</Text>
      </Box>
    )
  }
  if (error) {
    return (
      <Box borderStyle="round" borderColor={BORDER} paddingX={1} marginBottom={1}>
        <Text color="red">Couldn&apos;t load models: {error}</Text>
      </Box>
    )
  }

  if (step === "effort") {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={BORDER} paddingX={1} marginBottom={1}>
        <Text dimColor>Reasoning effort for advisor {chosen?.model.id} — ↑/↓ move · enter select · esc back</Text>
        {EFFORTS.map((opt, i) => {
          const on = i === optSel
          return (
            <Box key={opt}>
              <Text color={ACCENT}>{on ? figures.pointer : " "} </Text>
              <Text color={on ? ACCENT : undefined} bold={on}>
                {opt}
              </Text>
            </Box>
          )
        })}
      </Box>
    )
  }

  // list step — scrolling window around the selection
  const start = Math.max(0, Math.min(listSel - Math.floor(WINDOW / 2), Math.max(0, items.length - WINDOW)))
  const visible = items.slice(start, start + WINDOW)
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={BORDER} paddingX={1} marginBottom={1}>
      <Text dimColor>Set the advisor model — type to filter · ↑/↓ move · enter select · esc cancel</Text>
      <Box>
        <Text color={ACCENT}>{figures.pointer} </Text>
        <Text>{filter || ""}</Text>
        <Text dimColor>{filter ? "" : "type to search…"}</Text>
      </Box>
      {visible.map((item, i) => {
        const idx = start + i
        const on = idx === listSel
        if (item.off) {
          return (
            <Box key="__off__">
              <Text color={on ? ACCENT : undefined}>{on ? "❯ " : "  "}</Text>
              <Text color={on ? ACCENT : undefined} bold={on} dimColor={!on}>
                Turn advisor OFF
              </Text>
            </Box>
          )
        }
        const row = item.row
        return (
          <Box key={`${row.provider}/${row.model.id}`}>
            <Text color={on ? ACCENT : undefined}>{on ? "❯ " : "  "}</Text>
            <Text color={on ? ACCENT : undefined} bold={on}>
              {row.provider}/{row.model.id}
            </Text>
            <Text dimColor>
              {row.model.reasoning ? "  ◆ reasoning" : ""}
              {row.ready ? "" : "  [login needed]"}
            </Text>
          </Box>
        )
      })}
      <Text dimColor>
        {items.length - 1 > WINDOW ? `${listSel + 1}/${items.length - 1}` : `${filtered.length} models`}
        {busy ? "  · saving…" : ""}
      </Text>
    </Box>
  )
}
