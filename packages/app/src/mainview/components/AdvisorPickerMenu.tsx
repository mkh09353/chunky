import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { CheckIcon, ChevronUpDownIcon } from "@heroicons/react/24/outline"
import {
  listAllModels,
  prettyModel,
  setAdvisor,
  type AdvisorState,
  type ModelRow,
} from "../lib/api"

type Effort = "low" | "medium" | "high" | "xhigh" | "max"
const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"]

const KNOB_LABEL: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
}

/** Same case-insensitive subsequence fuzzy match as ModelPickerMenu. */
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
 * The composer's advisor picker (the app's /advisor): a quiet "Advisor: <model>"
 * trigger next to the model picker that opens an upward popover. The list has a
 * synthetic "Turn advisor OFF" row on top, then every provider's models
 * (fuzzy-searchable); effort knobs for the current advisor pin below. Every
 * action applies immediately via POST /api/advisor. The server auto-suppresses
 * an advisor that equals the executor model — surfaced as "(inactive)".
 * Reuses the chunky-model-* styles so the two pickers read as one family.
 */
export function AdvisorPickerMenu({
  baseUrl,
  advisor,
  onAdvisorChange,
  openSignal,
}: {
  baseUrl: string
  advisor: AdvisorState | null
  onAdvisorChange: (a: AdvisorState) => void
  /** Bump to open the menu programmatically (the /advisor command). */
  openSignal?: number
}) {
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState<ModelRow[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [filter, setFilter] = useState("")
  const [listSel, setListSel] = useState(0)

  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const close = useCallback(() => {
    setOpen(false)
    setSaveError(null)
  }, [])

  const openMenu = useCallback(() => {
    setFilter("")
    setListSel(0)
    setSaveError(null)
    setOpen(true)
    if (rows === null) {
      setLoadError(null)
      listAllModels(baseUrl)
        .then(setRows)
        .catch((err) => setLoadError((err as Error).message))
    }
  }, [baseUrl, rows])

  // The /advisor slash command bumps openSignal to open the menu from outside.
  const lastSignal = useRef(openSignal ?? 0)
  useEffect(() => {
    if (openSignal != null && openSignal !== lastSignal.current) {
      lastSignal.current = openSignal
      openMenu()
    }
  }, [openSignal, openMenu])

  // Close on outside click / Escape (document-level, mirroring ModelPickerMenu).
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close()
    }
    document.addEventListener("mousedown", onDown)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", onDown)
      document.removeEventListener("keydown", onKey)
    }
  }, [open, close])

  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  const currentKey =
    advisor?.enabled && advisor.model ? `${advisor.provider}/${advisor.model}` : null
  const currentRow = useMemo(
    () => (rows ?? []).find((r) => `${r.provider}/${r.model.id}` === currentKey) ?? null,
    [rows, currentKey],
  )

  const searching = filter.trim().length > 0
  const ranked = useMemo(() => {
    const all = rows ?? []
    if (!searching) return all
    return all
      .map((row) => ({
        row,
        s: fuzzyScore(filter, `${row.provider}/${row.model.id} ${row.model.name}`),
      }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.row)
  }, [rows, filter, searching])

  // Row 0 is the synthetic OFF row (hidden while searching); model rows follow.
  const offVisible = !searching
  const navLength = ranked.length + (offVisible ? 1 : 0)

  useEffect(() => {
    setListSel((s) => (navLength === 0 ? 0 : Math.min(s, navLength - 1)))
  }, [navLength])

  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" })
  }, [listSel, navLength])

  const apply = useCallback(
    async (patch: { enabled?: boolean; provider?: string; model?: string; effort?: Effort }) => {
      setBusy(true)
      setSaveError(null)
      try {
        const next = await setAdvisor(baseUrl, patch)
        onAdvisorChange(next)
      } catch (err) {
        setSaveError((err as Error).message)
      } finally {
        setBusy(false)
      }
    },
    [baseUrl, onAdvisorChange],
  )

  const turnOff = useCallback(() => void apply({ enabled: false }), [apply])
  const selectRow = useCallback(
    (row: ModelRow) => void apply({ enabled: true, provider: row.provider, model: row.model.id }),
    [apply],
  )
  const setEffort = useCallback((eff: Effort) => void apply({ effort: eff }), [apply])

  const activate = useCallback(
    (idx: number) => {
      if (offVisible && idx === 0) return turnOff()
      const row = ranked[idx - (offVisible ? 1 : 0)]
      if (row) selectRow(row)
    },
    [offVisible, ranked, turnOff, selectRow],
  )

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault()
        e.stopPropagation()
        close()
        return
      }
      if (busy) return
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault()
        e.stopPropagation()
        const delta = e.key === "ArrowDown" ? 1 : -1
        setListSel((s) => Math.min(Math.max(0, s + delta), Math.max(0, navLength - 1)))
        return
      }
      if (e.key === "Enter") {
        e.preventDefault()
        e.stopPropagation()
        activate(listSel)
      }
    },
    [busy, close, navLength, listSel, activate],
  )

  // Effort knobs make sense for a configured, reasoning advisor (fall back to
  // "has an effort set" until the rows load).
  const showEffort =
    advisor?.enabled && advisor.model
      ? currentRow
        ? currentRow.model.reasoning
        : advisor.effort != null
      : false

  const triggerLabel = advisor?.enabled && advisor.model ? prettyModel(advisor.model) : "Off"
  const inactive = Boolean(advisor?.enabled && advisor.model && !advisor.active)

  return (
    <div className="chunky-model-pick" ref={rootRef}>
      <button
        type="button"
        className="chunky-model-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={
          inactive
            ? "Advisor configured but inactive (same model as the executor) — click to change"
            : "The always-on advisor model the executor consults — click to change"
        }
        onClick={() => (open ? close() : openMenu())}
      >
        <span className="chunky-model-trigger-knobs">Advisor</span>
        <span className="chunky-model-trigger-name">{triggerLabel}</span>
        {advisor?.enabled && advisor.effort ? (
          <span className="chunky-model-trigger-knobs">{KNOB_LABEL[advisor.effort] ?? advisor.effort}</span>
        ) : null}
        {inactive ? <span className="chunky-model-trigger-knobs">inactive</span> : null}
        <ChevronUpDownIcon className="chunky-model-trigger-chevron" aria-hidden="true" />
      </button>

      {open ? (
        <div
          className="chunky-model-menu"
          role="dialog"
          aria-label="Pick an advisor model"
          onKeyDown={handleKeyDown}
          onClick={(e) => e.stopPropagation()}
        >
          <input
            ref={inputRef}
            className="chunky-model-filter"
            type="text"
            value={filter}
            spellCheck={false}
            placeholder="Search advisor models…"
            onChange={(e) => {
              setFilter(e.target.value)
              setListSel(0)
            }}
          />

          <div className="chunky-model-list" ref={listRef} role="listbox">
            {rows === null && !loadError ? (
              <div className="chunky-model-note">Loading models…</div>
            ) : loadError ? (
              <div className="chunky-model-error">Couldn&apos;t load models: {loadError}</div>
            ) : (
              <>
                {offVisible ? (
                  <button
                    type="button"
                    role="option"
                    aria-selected={!currentKey}
                    className="chunky-model-row"
                    data-active={listSel === 0 || undefined}
                    onMouseEnter={() => setListSel(0)}
                    onClick={turnOff}
                    disabled={busy}
                  >
                    <span className="chunky-model-row-name">Turn advisor off</span>
                    {!currentKey ? (
                      <CheckIcon className="chunky-model-row-check" aria-hidden="true" />
                    ) : null}
                  </button>
                ) : null}
                {ranked.length === 0 && searching ? (
                  <div className="chunky-model-note">No matches</div>
                ) : (
                  ranked.map((row, i) => {
                    const idx = i + (offVisible ? 1 : 0)
                    const key = `${row.provider}/${row.model.id}`
                    const isCurrent = key === currentKey
                    return (
                      <button
                        key={key}
                        type="button"
                        role="option"
                        aria-selected={isCurrent}
                        className="chunky-model-row"
                        data-active={idx === listSel || undefined}
                        title={`${prettyModel(row.model.id)}${row.model.reasoning ? " · reasoning" : ""}`}
                        onMouseEnter={() => setListSel(idx)}
                        onClick={() => selectRow(row)}
                        disabled={busy}
                      >
                        <span className="chunky-model-row-name">
                          <span className="chunky-model-row-provider">{row.provider}/</span>
                          {row.model.id}
                        </span>
                        {!row.ready ? (
                          <span className="chunky-model-row-hint">login needed</span>
                        ) : null}
                        {isCurrent ? (
                          <CheckIcon className="chunky-model-row-check" aria-hidden="true" />
                        ) : null}
                      </button>
                    )
                  })
                )}
              </>
            )}
          </div>

          {showEffort ? (
            <div className="chunky-model-footer">
              <div className="chunky-model-knobs">
                <span className="chunky-model-menu-title">Advisor effort</span>
                <div className="chunky-model-pills" role="radiogroup" aria-label="Advisor effort">
                  {EFFORTS.map((opt) => (
                    <button
                      key={opt}
                      type="button"
                      role="radio"
                      aria-checked={advisor?.effort === opt}
                      className={`chunky-model-pill${advisor?.effort === opt ? " chunky-model-pill-active" : ""}`}
                      onClick={() => setEffort(opt)}
                      disabled={busy}
                    >
                      {KNOB_LABEL[opt] ?? opt}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ) : null}

          {inactive ? (
            <div className="chunky-model-note">
              Inactive: the advisor matches the executor model, so the server suppresses it.
            </div>
          ) : null}
          {saveError ? <div className="chunky-model-error">{saveError}</div> : null}
          {busy ? <div className="chunky-model-note">Saving…</div> : null}
        </div>
      ) : null}
    </div>
  )
}
