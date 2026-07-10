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
type Speed = "standard" | "fast"

interface Row {
  provider: string
  ready: boolean
  model: ModelInfo
}

export interface ModelSelectionResult {
  provider: string
  model: string
  effort?: Effort
  speed?: Speed
}

interface Props {
  baseUrl: string
  onDone: (result: ModelSelectionResult, summary: string) => void
  onCancel: () => void
}

const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh"]
const SPEEDS: Speed[] = ["standard", "fast"]
const WINDOW = 10 // visible rows in the scrolling list

/**
 * Case-insensitive subsequence fuzzy match. Returns a score (higher = better),
 * or -1 for no match. Rewards contiguous runs and early matches so that typing
 * "opus" ranks `claude-opus-4-8` above an incidental o…p…u…s spread.
 */
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
    // closer matches and contiguous streaks score higher
    score += 10 - Math.min(9, found - ti) + streak * 3
    ti = found + 1
  }
  return score
}

/**
 * The fuzzy model picker opened by /model. Three steps:
 *   1. list  — provider/model rows; type to filter, ↑/↓, enter to choose.
 *   2. effort — shown only for reasoning models (low/medium/high/xhigh).
 *   3. speed  — shown only for Codex (standard/fast).
 * Esc steps back (and cancels from the list). Styled after the slash menu /
 * LoginPicker (rounded terracotta box, ❯ pointer).
 */
export function ModelPicker({ baseUrl, onDone, onCancel }: Props) {
  const rawSupported = Boolean(useStdin().isRawModeSupported)
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [filter, setFilter] = useState("")
  const [step, setStep] = useState<"list" | "effort" | "speed">("list")
  const [listSel, setListSel] = useState(0)
  const [optSel, setOptSel] = useState(0)
  const [chosen, setChosen] = useState<Row | null>(null)
  const [effort, setEffort] = useState<Effort | undefined>(undefined)

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
        const groups = await Promise.all(
          providers.map(async (p): Promise<Row[]> => {
            try {
              const r = await fetch(baseUrl + `/api/providers/${p.id}/models`)
              const b = (await r.json()) as { models?: ModelInfo[] }
              return (b.models ?? []).map((model) => ({ provider: p.id, ready: p.ready, model }))
            } catch {
              return []
            }
          }),
        )
        const all = groups.flat()
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

  // Keep the selection in-bounds when the filter narrows the list.
  useEffect(() => {
    setListSel((s) => (filtered.length === 0 ? 0 : Math.min(s, filtered.length - 1)))
  }, [filtered.length])

  async function submit(row: Row, eff?: Effort, spd?: Speed) {
    setBusy(true)
    const payload: ModelSelectionResult = {
      provider: row.provider,
      model: row.model.id,
      ...(eff ? { effort: eff } : {}),
      ...(spd ? { speed: spd } : {}),
    }
    try {
      const res = await fetch(baseUrl + "/api/model/select", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      })
      const body = (await res.json()) as { error?: string; provider?: string; model?: string }
      if (body.error) {
        onDone(payload, `Could not select ${row.model.id}: ${body.error}`)
        return
      }
      const bits = [`${row.provider} / ${row.model.id}`]
      if (eff) bits.push(`effort ${eff}`)
      if (spd) bits.push(`speed ${spd}`)
      const note = row.ready ? "" : `\n(note: ${row.provider} isn't logged in yet — run /login to authorize it.)`
      onDone(payload, `Model → ${bits.join(" · ")}${note}`)
    } catch (err) {
      onDone(payload, `Select request failed: ${String(err)}`)
    }
  }

  useInput(
    (input, key) => {
      if (busy || loading) return

      // ---- effort sub-picker ----
      if (step === "effort") {
        if (key.escape) {
          setStep("list")
          return
        }
        if (key.upArrow) return setOptSel((s) => (s - 1 + EFFORTS.length) % EFFORTS.length)
        if (key.downArrow) return setOptSel((s) => (s + 1) % EFFORTS.length)
        if (key.return) {
          const eff = EFFORTS[optSel]!
          if (chosen && chosen.provider === "codex") {
            setEffort(eff)
            setOptSel(0)
            setStep("speed")
          } else if (chosen) {
            void submit(chosen, eff)
          }
        }
        return
      }

      // ---- speed sub-picker (Codex only) ----
      if (step === "speed") {
        if (key.escape) {
          setOptSel(0)
          setStep("effort")
          return
        }
        if (key.upArrow) return setOptSel((s) => (s - 1 + SPEEDS.length) % SPEEDS.length)
        if (key.downArrow) return setOptSel((s) => (s + 1) % SPEEDS.length)
        if (key.return && chosen) void submit(chosen, effort, SPEEDS[optSel]!)
        return
      }

      // ---- model list ----
      if (key.escape) return onCancel()
      if (key.upArrow) return setListSel((s) => Math.max(0, s - 1))
      if (key.downArrow) return setListSel((s) => Math.min(Math.max(0, filtered.length - 1), s + 1))
      if (key.return) {
        const row = filtered[listSel]
        if (!row) return
        if (row.model.reasoning) {
          setChosen(row)
          setEffort(undefined)
          setOptSel(0)
          setStep("effort")
        } else {
          void submit(row)
        }
        return
      }
      if (key.backspace || key.delete) {
        setFilter((f) => f.slice(0, -1))
        return
      }
      // printable characters extend the filter
      if (input && !key.ctrl && !key.meta) {
        setFilter((f) => f + input)
        setListSel(0)
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

  if (step === "effort" || step === "speed") {
    const options: string[] = step === "effort" ? EFFORTS : SPEEDS
    const title =
      step === "effort"
        ? `Reasoning effort for ${chosen?.model.id}`
        : `Speed for ${chosen?.model.id}`
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={BORDER} paddingX={1} marginBottom={1}>
        <Text dimColor>
          {title} — ↑/↓ move · enter select · esc back
        </Text>
        {options.map((opt, i) => {
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
  const start = Math.max(0, Math.min(listSel - Math.floor(WINDOW / 2), Math.max(0, filtered.length - WINDOW)))
  const visible = filtered.slice(start, start + WINDOW)
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={BORDER} paddingX={1} marginBottom={1}>
      <Text dimColor>
        Pick a model — type to filter · ↑/↓ move · enter select · esc cancel
      </Text>
      <Box>
        <Text color={ACCENT}>{figures.pointer} </Text>
        <Text>{filter || ""}</Text>
        <Text dimColor>{filter ? "" : "type to search…"}</Text>
      </Box>
      {filtered.length === 0 ? (
        <Text dimColor>no matches</Text>
      ) : (
        visible.map((row, i) => {
          const idx = start + i
          const on = idx === listSel
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
        })
      )}
      <Text dimColor>
        {filtered.length > WINDOW ? `${listSel + 1}/${filtered.length}` : `${filtered.length} models`}
        {busy ? "  · saving…" : ""}
      </Text>
    </Box>
  )
}
