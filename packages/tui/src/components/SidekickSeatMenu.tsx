import { useEffect, useMemo, useState } from "react"
import { TextAttributes } from "@opentui/core"
import figures from "figures"
import { ACCENT, BORDER } from "../theme.js"
import { rawModeSupported, useInput } from "../useInput.js"

const { BOLD, DIM } = TextAttributes
const WINDOW = 10
const SEAT_NAME = /^[a-z][a-z0-9_-]{0,23}$/

interface SeatSpec {
  provider: string
  model: string
  effort?: string
}

interface SidekickResponse {
  config?: { enabled?: boolean; provider?: string; model?: string; effort?: string }
  seats?: Record<string, SeatSpec>
}

type Row = { kind: "default"; config: SidekickResponse["config"] } | { kind: "seat"; name: string; spec: SeatSpec } | { kind: "add" }

interface Props {
  baseUrl: string
  /** Called with the selected seat; undefined means the default seat. */
  onDone: (seatName?: string) => void
  onCancel: () => void
}

function modelLabel(provider?: string, model?: string, effort?: string) {
  if (!provider || !model) return "inherit"
  return `${provider}/${model}${effort ? ` (${effort})` : ""}`
}

function validSeatName(name: string) {
  return SEAT_NAME.test(name) && name !== "default"
}

/** First step of /sidekick: make the default and named seats discoverable. */
export function SidekickSeatMenu({ baseUrl, onDone, onCancel }: Props) {
  const [config, setConfig] = useState<SidekickResponse["config"]>()
  const [seats, setSeats] = useState<Record<string, SeatSpec>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState(0)
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState("")
  const [nameError, setNameError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(baseUrl + "/api/sidekick")
        const body = (await res.json()) as SidekickResponse
        if (!res.ok) throw new Error("could not load sidekick seats")
        if (!cancelled) {
          setConfig(body.config)
          setSeats(body.seats ?? {})
          setLoading(false)
        }
      } catch (err) {
        if (!cancelled) {
          setError(String(err))
          setLoading(false)
        }
      }
    })()
    return () => { cancelled = true }
  }, [baseUrl])

  const rows = useMemo<Row[]>(
    () => [
      { kind: "default", config },
      ...Object.keys(seats).sort().map((seat) => ({ kind: "seat" as const, name: seat, spec: seats[seat]! })),
      { kind: "add" },
    ],
    [config, seats],
  )

  useInput((input, key) => {
    if (loading) return
    if (adding) {
      if (key.escape) {
        setAdding(false)
        setName("")
        setNameError(null)
        return
      }
      if (key.backspace || key.delete) {
        setName((current) => {
          const next = current.slice(0, -1)
          setNameError(next && !validSeatName(next) ? "Use a short lowercase seat name (not \"default\")." : null)
          return next
        })
        return
      }
      if (key.return) {
        if (!validSeatName(name)) {
          setNameError(name === "default" ? '"default" is reserved.' : "Enter a short lowercase seat name, e.g. frontend.")
        } else {
          onDone(name)
        }
        return
      }
      if (input && !key.ctrl && !key.meta) {
        const next = name + input.toLowerCase()
        setName(next)
        setNameError(next === "default" ? '"default" is reserved.' : !validSeatName(next) ? "Use lowercase letters, numbers, _ or - (max 24 characters)." : null)
      }
      return
    }
    if (key.escape) return onCancel()
    if (key.upArrow) return setSelected((s) => Math.max(0, s - 1))
    if (key.downArrow) return setSelected((s) => Math.min(rows.length - 1, s + 1))
    if (key.return) {
      const row = rows[selected]
      if (!row) return
      if (row.kind === "add") {
        setAdding(true)
        setName("")
        setNameError(null)
      } else if (row.kind === "default") onDone()
      else onDone(row.name)
    }
  }, { isActive: rawModeSupported })

  if (loading) return <box border borderStyle="rounded" borderColor={BORDER} paddingX={1} marginBottom={1}><text attributes={DIM}>Loading sidekick seats…</text></box>
  if (error) return <box border borderStyle="rounded" borderColor={BORDER} paddingX={1} marginBottom={1}><text fg="red">Couldn&apos;t load sidekick seats: {error}</text></box>

  if (adding) {
    return (
      <box flexDirection="column" border borderStyle="rounded" borderColor={BORDER} paddingX={1} marginBottom={1}>
        <text attributes={DIM}>Add a sidekick seat — type a name · enter continue · esc back</text>
        <box flexDirection="row"><text fg={ACCENT}>{figures.pointer} </text><text>{name}</text><text attributes={DIM}>{name ? "" : "e.g. frontend, backend"}</text></box>
        {nameError && <text fg="red">{nameError}</text>}
        <text attributes={DIM}>Names: lowercase slug, up to 24 characters</text>
      </box>
    )
  }

  const start = Math.max(0, Math.min(selected - Math.floor(WINDOW / 2), Math.max(0, rows.length - WINDOW)))
  return (
    <box flexDirection="column" border borderStyle="rounded" borderColor={BORDER} paddingX={1} marginBottom={1}>
      <text attributes={DIM}>Choose a sidekick seat · ↑/↓ move · enter select · esc cancel</text>
      {rows.slice(start, start + WINDOW).map((row, i) => {
        const index = start + i
        const focused = index === selected
        const prefix = focused ? "❯ " : "  "
        if (row.kind === "add") return <text key="add" fg={focused ? ACCENT : undefined} attributes={focused ? BOLD : 0}>{prefix}+ Add a seat…</text>
        if (row.kind === "default") return <box key="default" flexDirection="row"><text fg={focused ? ACCENT : undefined} attributes={focused ? BOLD : 0}>{prefix}Sidekick (default)</text><text attributes={DIM}>  {row.config?.enabled === false ? "off" : modelLabel(row.config?.provider, row.config?.model, row.config?.effort)}</text></box>
        return <box key={row.name} flexDirection="row"><text fg={focused ? ACCENT : undefined} attributes={focused ? BOLD : 0}>{prefix}{row.name}</text><text attributes={DIM}>  {modelLabel(row.spec.provider, row.spec.model, row.spec.effort)}</text></box>
      })}
      <text attributes={DIM}>{rows.length > WINDOW ? `${selected + 1}/${rows.length}` : `${rows.length - 2} named seat${rows.length === 3 ? "" : "s"}`}</text>
    </box>
  )
}
