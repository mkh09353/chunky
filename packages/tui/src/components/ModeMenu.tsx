import { useEffect, useMemo, useState } from "react"
import { TextAttributes } from "@opentui/core"
import figures from "figures"
import { ROUTES, type ModeInfo, type ModeSpec, type ModesResponse } from "@chunky/protocol"
import { ACCENT, BORDER, WARNING } from "../theme.js"
import { incognitoAppliedLine, isIncognitoMode, type SavedMode } from "../incognitoModes.js"
import { rawModeSupported, useInput } from "../useInput.js"

const { BOLD, DIM } = TextAttributes
const WINDOW = 10
const NAME_RE = /^[\w+.-]{1,40}$/

// ---- display helpers (ported from App.tsx so the menu is self-contained) ----
const MODEL_ACRONYMS = new Set(["glm", "gpt", "api", "llm"])

/** Prettify a model id for display: `grok-4.5` → `Grok 4.5`, `glm-5.2` → `GLM 5.2`. */
function prettyModel(id: string | null | undefined): string {
  if (!id) return "…"
  return id
    .replace(/\[.*?\]/g, "")
    .split(/[-_]/)
    .filter(Boolean)
    .map((p) => (MODEL_ACRONYMS.has(p.toLowerCase()) ? p.toUpperCase() : /^[\d.]+$/.test(p) ? p : p[0]!.toUpperCase() + p.slice(1)))
    .join(" ")
}

const eff = (e?: string | null) => (e ? ` ${e}` : "")
const effortParen = (e?: string | null) => (e ? ` (${e})` : "")

/** Compact one-line trio preview for a row, e.g.
 *  `Fable low · ⚒ Luna xhigh · frontend=Opus · ✦ Sol`. Exported for testing. */
export function previewSpec(spec: ModeSpec): string {
  const parts = [`${prettyModel(spec.model)}${eff(spec.effort)}`]
  parts.push(`⚒ ${spec.sidekick ? `${prettyModel(spec.sidekick.model)}${eff(spec.sidekick.effort)}` : "inherit"}`)
  if (spec.sidekickSeats) {
    for (const [n, s] of Object.entries(spec.sidekickSeats).sort(([a], [b]) => a.localeCompare(b))) {
      parts.push(`${n}=${prettyModel(s.model)}${eff(s.effort)}`)
    }
  }
  parts.push(`✦ ${spec.advisor ? `${prettyModel(spec.advisor.model)}${eff(spec.advisor.effort)}` : "off"}`)
  return parts.join(" · ")
}

/** ` · allow ollama, local` — the providers an incognito mode may use. Shown
 *  only in the /incognito picker, where the allowlist IS the point. */
function allowSuffix(mode: SavedMode): string {
  const allow = mode.incognito?.allow ?? []
  return allow.length > 0 ? ` · allow ${allow.join(", ")}` : ""
}

/** Verbose trio (matches App.tsx `doMode`'s save summary). */
function fmtSpec(spec: ModeSpec): string {
  const seats =
    spec.sidekickSeats && Object.keys(spec.sidekickSeats).length > 0
      ? ` + seats ${Object.entries(spec.sidekickSeats)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([n, s]) => `${n}=${prettyModel(s.model)}${effortParen(s.effort)}`)
          .join(", ")}`
      : ""
  return `${prettyModel(spec.model)}${effortParen(spec.effort)} + sidekick ${
    spec.sidekick ? `${prettyModel(spec.sidekick.model)}${effortParen(spec.sidekick.effort)}` : "inherit"
  }${seats} + advisor ${spec.advisor ? `${prettyModel(spec.advisor.model)}${effortParen(spec.advisor.effort)}` : "off"}`
}

/** The POST /api/modes/:name/apply response — carries the full trio so the
 *  caller can update executor + advisor + sidekick state without re-fetching. */
export interface ModeApplyPayload {
  applied: string
  provider: string
  model: string | null
  effort?: string | null
  speed?: string | null
  advisor?: { enabled?: boolean; provider?: string; model?: string; effort?: string }
  advisorActive?: boolean
  sidekick?: { enabled?: boolean; provider?: string; model?: string; effort?: string }
  sidekickSeats?: Record<string, { provider: string; model: string; effort?: string }>
}

type Row = { kind: "current"; spec: ModeSpec } | { kind: "mode"; info: ModeInfo } | { kind: "save" }

interface Props {
  baseUrl: string
  /** Applied a saved mode: consume the response to update App state + close. */
  onApplied: (payload: ModeApplyPayload, summary: string) => void
  /** Saved/deleted/error: echo the summary line + close. */
  onNotice: (summary: string) => void
  onCancel: () => void
  /** /incognito's picker: show ONLY incognito modes, as a pure chooser — no
   *  current-pairing row, no save row, no delete. Off (the default) is /mode's
   *  menu, unchanged. */
  incognitoOnly?: boolean
}

/**
 * The interactive /mode menu. Lists the current (unsaved) trio pinned at top,
 * every saved mode with a one-line trio preview, and a "Save current as…" row
 * that flips into inline name entry. Enter applies a saved mode; `d` deletes it
 * behind a one-keystroke confirm. Mirrors SidekickSeatMenu's visual language.
 */
export function ModeMenu({ baseUrl, onApplied, onNotice, onCancel, incognitoOnly = false }: Props) {
  const [current, setCurrent] = useState<ModeSpec | null>(null)
  const [modes, setModes] = useState<ModeInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [selected, setSelected] = useState(0)
  const [sub, setSub] = useState<"list" | "adding" | "confirm">("list")
  const [name, setName] = useState("")
  const [nameError, setNameError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(baseUrl + ROUTES.modes)
        const body = (await res.json()) as ModesResponse
        if (!res.ok) throw new Error("could not load modes")
        if (!cancelled) {
          setCurrent(body.current)
          setModes((body.modes ?? []).filter((m) => !incognitoOnly || isIncognitoMode(m as SavedMode)))
          // Default the cursor to the first saved mode, else the "Save" row. The
          // incognito picker has no pinned current row, so its first mode is 0.
          setSelected(incognitoOnly ? 0 : 1)
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
  }, [baseUrl, incognitoOnly])

  const rows = useMemo<Row[]>(
    () =>
      incognitoOnly
        ? modes.map((info) => ({ kind: "mode" as const, info }))
        : [
            ...(current ? [{ kind: "current" as const, spec: current }] : []),
            ...modes.map((info) => ({ kind: "mode" as const, info })),
            { kind: "save" as const },
          ],
    [current, modes, incognitoOnly],
  )

  // Keep the selection in-bounds when the row set changes.
  useEffect(() => {
    setSelected((s) => Math.min(Math.max(0, s), Math.max(0, rows.length - 1)))
  }, [rows.length])

  async function apply(modeName: string) {
    setBusy(true)
    try {
      const res = await fetch(baseUrl + ROUTES.applyMode(modeName), { method: "POST" })
      const body = (await res.json()) as ModeApplyPayload | { error: string }
      if ("error" in body) {
        onNotice(`Mode: ${body.error} — \`/mode\` lists what's saved.`)
        return
      }
      const trio = `${prettyModel(body.model)}${effortParen(body.effort)} · ${body.provider}`
      onApplied(
        body,
        incognitoOnly ? incognitoAppliedLine(body.applied, trio) : `Mode "${body.applied}" applied: ${trio}.`,
      )
    } catch (err) {
      onNotice(`Mode request failed: ${String(err)}`)
    }
  }

  async function save(modeName: string) {
    setBusy(true)
    try {
      const res = await fetch(baseUrl + ROUTES.modes, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: modeName }),
      })
      const body = (await res.json()) as ModesResponse | { error: string }
      if ("error" in body) {
        onNotice(`Mode save failed: ${body.error}`)
        return
      }
      const cur = current
      const samePair = cur?.advisor && cur.advisor.provider === cur.provider && cur.advisor.model === cur.model
      onNotice(
        `Mode "${modeName}" saved: ${cur ? fmtSpec(cur) : "current pairing"}.${
          samePair ? " ⚠ advisor equals the executor — it will be suppressed; pick a different advisor for this mode." : ""
        }`,
      )
    } catch (err) {
      onNotice(`Mode request failed: ${String(err)}`)
    }
  }

  async function remove(modeName: string) {
    setBusy(true)
    try {
      const res = await fetch(baseUrl + ROUTES.deleteMode(modeName), { method: "DELETE" })
      const body = (await res.json()) as ModesResponse | { error: string }
      onNotice("error" in body ? `Mode delete failed: ${body.error}` : `Mode "${modeName}" deleted.`)
    } catch (err) {
      onNotice(`Mode request failed: ${String(err)}`)
    }
  }

  useInput(
    (input, key) => {
      if (busy || loading) return

      // ---- inline name entry ("Save current as…") ----
      if (sub === "adding") {
        if (key.escape) {
          setSub("list")
          setName("")
          setNameError(null)
          return
        }
        if (key.backspace || key.delete) {
          setName((cur) => {
            const next = cur.slice(0, -1)
            setNameError(next && !NAME_RE.test(next) ? "Use letters, digits, _ + . - (max 40)." : null)
            return next
          })
          return
        }
        if (key.return) {
          if (!NAME_RE.test(name)) {
            setNameError("Enter a name: letters, digits, _ + . - (max 40).")
          } else {
            void save(name)
          }
          return
        }
        if (input && !key.ctrl && !key.meta) {
          const next = name + input
          setName(next)
          setNameError(!NAME_RE.test(next) ? "Use letters, digits, _ + . - (max 40)." : null)
        }
        return
      }

      // ---- delete confirmation ----
      if (sub === "confirm") {
        const row = rows[selected]
        if ((input === "y" || input === "Y") && row?.kind === "mode") {
          void remove(row.info.name)
          return
        }
        if (key.escape || input === "n" || input === "N") setSub("list")
        return
      }

      // ---- list ----
      if (key.escape) return onCancel()
      if (key.upArrow) return setSelected((s) => Math.max(0, s - 1))
      if (key.downArrow) return setSelected((s) => Math.min(rows.length - 1, s + 1))
      if (key.return) {
        const row = rows[selected]
        if (!row) return
        if (row.kind === "save") {
          setSub("adding")
          setName("")
          setNameError(null)
        } else if (row.kind === "mode") {
          void apply(row.info.name)
        }
        // "current" row is a non-actionable display row.
        return
      }
      // Delete is a /mode affordance; the incognito picker only picks.
      if (!incognitoOnly && (input === "d" || input === "D")) {
        if (rows[selected]?.kind === "mode") setSub("confirm")
      }
    },
    { isActive: rawModeSupported },
  )

  // ---- render ----
  if (loading) {
    return (
      <box border borderStyle="rounded" borderColor={BORDER} paddingX={1} marginBottom={1}>
        <text attributes={DIM}>Loading modes…</text>
      </box>
    )
  }
  if (error) {
    return (
      <box border borderStyle="rounded" borderColor={BORDER} paddingX={1} marginBottom={1}>
        <text fg="red">Couldn&apos;t load modes: {error}</text>
      </box>
    )
  }

  if (sub === "adding") {
    return (
      <box flexDirection="column" border borderStyle="rounded" borderColor={BORDER} paddingX={1} marginBottom={1}>
        <text attributes={DIM}>Save current pairing as — type a name · enter save · esc back</text>
        <box flexDirection="row">
          <text fg={ACCENT}>{figures.pointer} </text>
          <text>{name}</text>
          <text attributes={DIM}>{name ? "" : "e.g. review, fast, deep"}</text>
        </box>
        {nameError && <text fg="red">{nameError}</text>}
        <text attributes={DIM}>{current ? previewSpec(current) : ""}</text>
      </box>
    )
  }

  const start = Math.max(0, Math.min(selected - Math.floor(WINDOW / 2), Math.max(0, rows.length - WINDOW)))
  const visible = rows.slice(start, start + WINDOW)
  const help =
    sub === "confirm"
      ? "Confirm delete · y delete · n/esc cancel"
      : incognitoOnly
        ? "Incognito modes · ↑/↓ move · enter apply (new sessions go off the record) · esc close"
        : "Modes · ↑/↓ move · enter apply · d delete · esc close"
  return (
    <box flexDirection="column" border borderStyle="rounded" borderColor={BORDER} paddingX={1} marginBottom={1}>
      <text attributes={DIM}>{help}</text>
      {visible.map((row, i) => {
        const idx = start + i
        const on = idx === selected
        const prefix = on ? "❯ " : "  "
        if (row.kind === "save") {
          return (
            <text key="__save__" fg={on ? ACCENT : undefined} attributes={on ? BOLD : 0}>
              {prefix}+ Save current as…
            </text>
          )
        }
        if (row.kind === "current") {
          return (
            <box key="__current__" flexDirection="row">
              <text fg={on ? ACCENT : undefined} attributes={on ? BOLD : 0}>
                {prefix}Current (unsaved)
              </text>
              <text attributes={DIM}>  {previewSpec(row.spec)}</text>
            </box>
          )
        }
        if (sub === "confirm" && on) {
          return (
            <text key={row.info.name} fg={WARNING}>
              {prefix}delete &quot;{row.info.name}&quot;? y/n
            </text>
          )
        }
        return (
          <box key={row.info.name} flexDirection="row">
            <text fg={on ? ACCENT : undefined} attributes={on ? BOLD : 0}>
              {prefix}{row.info.name}
            </text>
            <text attributes={DIM}>  {previewSpec(row.info)}{incognitoOnly ? allowSuffix(row.info as SavedMode) : ""}</text>
          </box>
        )
      })}
      {modes.length === 0 && !incognitoOnly && (
        <text attributes={DIM}>No saved modes yet — pick &quot;Save current as…&quot; to snapshot this pairing.</text>
      )}
      <text attributes={DIM}>
        {rows.length > WINDOW
          ? `${selected + 1}/${rows.length}`
          : incognitoOnly
            ? `${modes.length} incognito mode${modes.length === 1 ? "" : "s"}`
            : `${modes.length} saved mode${modes.length === 1 ? "" : "s"}`}
        {busy ? "  · saving…" : ""}
      </text>
    </box>
  )
}
