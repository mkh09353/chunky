import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronUpDownIcon,
  StarIcon,
} from "@heroicons/react/24/outline"
import { StarIcon as StarIconSolid } from "@heroicons/react/24/solid"
import {
  listAllModels,
  prettyModel,
  providerMark,
  selectModel,
  type ModelRow,
  type ModelSelection,
} from "../lib/api"

type Effort = "low" | "medium" | "high" | "xhigh" | "max"
type Speed = "standard" | "fast"

const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"]
const SPEEDS: Speed[] = ["standard", "fast"]

// Display names for the raw knob values the server accepts ("Extra High"
// matches the original Codex app's reasoning labels).
const KNOB_LABEL: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
  standard: "Standard",
  fast: "Fast",
}

// Favorited models, persisted per client as "provider/model-id" keys.
const FAVORITES_KEY = "chunky.favoriteModels"

function rowKey(row: ModelRow): string {
  return `${row.provider}/${row.model.id}`
}

function loadFavorites(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(FAVORITES_KEY) ?? "[]") as unknown
    return new Set(Array.isArray(raw) ? raw.filter((v) => typeof v === "string") : [])
  } catch {
    return new Set()
  }
}

/**
 * Case-insensitive subsequence fuzzy match (same scoring as the TUI's /model
 * picker). Returns a score (higher = better), or -1 for no match. Rewards
 * contiguous runs and early matches so typing "opus" ranks `claude-opus-4-8`
 * above an incidental o…p…u…s spread.
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
    score += 10 - Math.min(9, found - ti) + streak * 3
    ti = found + 1
  }
  return score
}

/**
 * The composer's model picker: a quiet "<model> <effort>" trigger in the
 * footer (Codex-style, next to the send button) that opens an upward popover.
 *
 * One panel, no steps: a fuzzy-searchable model list on top and the knobs for
 * the CURRENT selection pinned below it — reasoning effort for reasoning
 * models, speed for Codex — so changing effort never requires re-picking the
 * model. Rows can be starred; with favorites saved, the list opens collapsed
 * to just them (plus an "All models" expander) instead of every provider's
 * full catalog.
 *
 * Every action applies immediately via POST /api/model/select (the server
 * remembers each provider's effort/speed, so a bare model switch keeps them).
 * The menu stays open for follow-up tweaks; Esc or clicking away closes it.
 */
export function ModelPickerMenu({
  baseUrl,
  model,
  onModelChange,
  openSignal,
}: {
  baseUrl: string
  model: ModelSelection | null
  onModelChange: (sel: ModelSelection) => void
  /** Bump to open the menu programmatically (the /model command). */
  openSignal?: number
}) {
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState<ModelRow[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [filter, setFilter] = useState("")
  const [listSel, setListSel] = useState(0)
  const [showAll, setShowAll] = useState(false)
  const [favorites, setFavorites] = useState<Set<string>>(loadFavorites)

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
    setShowAll(false)
    setSaveError(null)
    setOpen(true)
    // Fetch once per app run; a reopen reuses the cached rows.
    if (rows === null) {
      setLoadError(null)
      listAllModels(baseUrl)
        .then(setRows)
        .catch((err) => setLoadError((err as Error).message))
    }
  }, [baseUrl, rows])

  // The /model slash command bumps openSignal to open the menu from outside.
  const lastSignal = useRef(openSignal ?? 0)
  useEffect(() => {
    if (openSignal != null && openSignal !== lastSignal.current) {
      lastSignal.current = openSignal
      openMenu()
    }
  }, [openSignal, openMenu])

  // Close on outside click. Escape is document-level (not just the menu's
  // keydown handler) because a clicked pill disables itself while its save is
  // in flight, dropping focus to <body> — Esc must still close from there.
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

  const currentKey = model?.model ? `${model.provider}/${model.model}` : null
  const currentRow = useMemo(
    () => (rows ?? []).find((r) => rowKey(r) === currentKey) ?? null,
    [rows, currentKey],
  )

  const searching = filter.trim().length > 0

  // Favorites section: starred rows, with the current model surfaced on top
  // even when it isn't starred (so the ✓ is always visible at a glance). The
  // compact view only applies when something is actually starred — otherwise
  // hasFavorites is false and the full list shows.
  const hasFavorites = useMemo(
    () => (rows ?? []).some((r) => favorites.has(rowKey(r))),
    [rows, favorites],
  )
  const favoriteRows = useMemo(() => {
    if (!hasFavorites) return []
    const favs = (rows ?? []).filter((r) => favorites.has(rowKey(r)))
    if (currentRow && !favorites.has(rowKey(currentRow))) return [currentRow, ...favs]
    return favs
  }, [rows, favorites, currentRow, hasFavorites])

  const otherRows = useMemo(() => {
    const all = rows ?? []
    const shown = new Set(favoriteRows.map(rowKey))
    return all.filter((r) => !shown.has(rowKey(r)))
  }, [rows, favoriteRows])

  const ranked = useMemo(() => {
    const all = rows ?? []
    if (!searching) return all
    return all
      .map((row) => ({ row, s: fuzzyScore(filter, `${row.provider}/${row.model.id} ${row.model.name}`) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.row)
  }, [rows, filter, searching])

  // Collapsed-by-default only when there are favorites to collapse to.
  const collapsed = !searching && hasFavorites && !showAll

  // The rows arrow keys walk, in exact render order.
  const navRows = useMemo(() => {
    if (searching) return ranked
    if (!hasFavorites) return rows ?? []
    return collapsed ? favoriteRows : [...favoriteRows, ...otherRows]
  }, [searching, ranked, hasFavorites, favoriteRows, otherRows, collapsed, rows])

  // Keep the keyboard selection in-bounds when the visible set changes.
  useEffect(() => {
    setListSel((s) => (navRows.length === 0 ? 0 : Math.min(s, navRows.length - 1)))
  }, [navRows.length])

  // Keep the active row visible while arrowing through a scrolled list.
  useEffect(() => {
    listRef.current
      ?.querySelector('[data-active="true"]')
      ?.scrollIntoView({ block: "nearest" })
  }, [listSel, navRows.length])

  const apply = useCallback(
    async (payload: { provider: string; model: string; effort?: Effort; speed?: Speed }) => {
      setBusy(true)
      setSaveError(null)
      try {
        const sel = await selectModel(baseUrl, payload)
        onModelChange(sel)
      } catch (err) {
        setSaveError((err as Error).message)
      } finally {
        setBusy(false)
      }
    },
    [baseUrl, onModelChange],
  )

  // Bare model switch: the server keeps that provider's remembered
  // effort/speed, and the pinned knobs below reflect (and can change) them.
  const selectRow = useCallback(
    (row: ModelRow) => void apply({ provider: row.provider, model: row.model.id }),
    [apply],
  )

  const setEffort = useCallback(
    (eff: Effort) => {
      if (model?.model) void apply({ provider: model.provider, model: model.model, effort: eff })
    },
    [apply, model],
  )

  const setSpeed = useCallback(
    (spd: Speed) => {
      if (model?.model) void apply({ provider: model.provider, model: model.model, speed: spd })
    },
    [apply, model],
  )

  const toggleFavorite = useCallback(
    (row: ModelRow) => {
      // Starring the first favorite flips the view from flat to sectioned —
      // keep it expanded so rows don't vanish mid-browse (next open collapses).
      if (!hasFavorites) setShowAll(true)
      setFavorites((prev) => {
        const next = new Set(prev)
        const key = rowKey(row)
        if (next.has(key)) next.delete(key)
        else next.add(key)
        localStorage.setItem(FAVORITES_KEY, JSON.stringify([...next]))
        return next
      })
    },
    [hasFavorites],
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
        setListSel((s) => Math.min(Math.max(0, s + delta), Math.max(0, navRows.length - 1)))
        return
      }
      if (e.key === "Enter") {
        e.preventDefault()
        e.stopPropagation()
        const row = navRows[listSel]
        if (row) selectRow(row)
      }
      if (e.key === "f" || e.key === "F") {
        e.preventDefault()
        const row = navRows[listSel]
        if (row) toggleFavorite(row)
      }
    },
    [busy, close, navRows, listSel, selectRow],
  )

  // One model row. The star is a role="button" span (rows are <button>s and
  // buttons can't nest); idx is the row's position in navRows for keyboard nav.
  const renderRow = (row: ModelRow, idx: number) => {
    const key = rowKey(row)
    const isCurrent = key === currentKey
    const isFav = favorites.has(key)
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
        id={`chunky-model-option-${idx}`}
        onKeyDown={(e) => {
          if ((e.key === "f" || e.key === "F") && !e.defaultPrevented) {
            e.preventDefault()
            toggleFavorite(row)
          }
        }}
        onClick={() => selectRow(row)}
        disabled={busy}
      >
        <span className="chunky-model-row-name">
          <span className="chunky-model-row-provider">{row.provider}/</span>
          {row.model.id}
        </span>
        {row.model.custom ? (
          <span className="chunky-model-row-hint">{row.model.verified ? "custom" : "custom · unverified"}</span>
        ) : null}
        {!row.ready ? <span className="chunky-model-row-hint">login needed</span> : null}
        {isCurrent ? <CheckIcon className="chunky-model-row-check" aria-hidden="true" /> : null}
        <span
          role="button"
          tabIndex={-1}
          className={`chunky-model-star${isFav ? " chunky-model-star-on" : ""}`}
          aria-label={isFav ? `Unfavorite ${key}` : `Favorite ${key}`}
          title={isFav ? "Remove from favorites" : "Add to favorites"}
          onClick={(e) => {
            e.stopPropagation()
            toggleFavorite(row)
          }}
        >
          {isFav ? <StarIconSolid aria-hidden="true" /> : <StarIcon aria-hidden="true" />}
        </span>
      </button>
    )
  }

  // Pinned knobs for the current selection. Reasoning effort shows for
  // reasoning models (falling back to "has an effort set" until rows load);
  // speed is a Codex-only concept.
  const showEffort = currentRow ? currentRow.model.reasoning : model?.effort != null
  const showSpeed = model?.provider === "codex"

  const renderKnobs = (label: string, options: string[], active: string | null | undefined, onPick: (v: string) => void) => (
    <div className="chunky-model-knobs">
      <span className="chunky-model-menu-title">{label}</span>
      <div className="chunky-model-pills" role="radiogroup" aria-label={label}>
        {options.map((opt) => (
          <button
            key={opt}
            type="button"
            role="radio"
            aria-checked={active === opt}
            className={`chunky-model-pill${active === opt ? " chunky-model-pill-active" : ""}`}
            onClick={() => onPick(opt)}
            disabled={busy}
          >
            {KNOB_LABEL[opt] ?? opt}
          </button>
        ))}
      </div>
    </div>
  )

  const triggerName = model ? prettyModel(model.model) : "Model"
  const triggerKnobs = model
    ? [model.effort, model.speed === "fast" ? "fast" : null]
        .filter(Boolean)
        .map((v) => KNOB_LABEL[v as string] ?? v)
        .join(" · ")
    : ""

  return (
    <div className="chunky-model-pick" ref={rootRef}>
      <button
        type="button"
        className="chunky-model-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={model?.provider ? `Provider: ${model.provider} — click to change model` : "Pick a model"}
        onClick={() => (open ? close() : openMenu())}
      >
        {model?.provider ? (
          <span className="chunky-provider-mark" title={`Provider: ${model.provider}`} aria-label={`Provider ${model.provider}`}>
            {providerMark(model.provider)}
          </span>
        ) : null}
        <span className="chunky-model-trigger-name">{triggerName}</span>
        {triggerKnobs ? <span className="chunky-model-trigger-knobs">{triggerKnobs}</span> : null}
        <ChevronUpDownIcon className="chunky-model-trigger-chevron" aria-hidden="true" />
      </button>

      {open ? (
        <div
          className="chunky-model-menu"
          role="dialog"
          aria-label="Pick a model"
          onKeyDown={handleKeyDown}
          // ChatComposer's body click handler focuses the composer input on any
          // click it doesn't recognise as interactive (our filter <input> isn't
          // in its allowlist) — keep menu clicks from reaching it.
          onClick={(e) => e.stopPropagation()}
        >
          <input
            ref={inputRef}
            className="chunky-model-filter"
            type="text"
            value={filter}
            spellCheck={false}
            placeholder="Search models…"
            onChange={(e) => {
              setFilter(e.target.value)
              setListSel(0)
            }}
          />

          <div className="chunky-model-list" ref={listRef} role="listbox" aria-activedescendant={`chunky-model-option-${listSel}`}>
            {rows === null && !loadError ? (
              <div className="chunky-model-note">Loading models…</div>
            ) : loadError ? (
              <div className="chunky-model-error">Couldn&apos;t load models: {loadError}</div>
            ) : navRows.length === 0 && searching ? (
              <div className="chunky-model-note">No matches</div>
            ) : searching || !hasFavorites ? (
              navRows.map((row, i) => renderRow(row, i))
            ) : (
              <>
                <span className="chunky-model-menu-title">Favorites</span>
                {favoriteRows.map((row, i) => renderRow(row, i))}
                <button
                  type="button"
                  className="chunky-model-showall"
                  aria-expanded={!collapsed}
                  onClick={() => setShowAll((v) => !v)}
                >
                  {collapsed ? (
                    <ChevronRightIcon aria-hidden="true" />
                  ) : (
                    <ChevronDownIcon aria-hidden="true" />
                  )}
                  All models ({(rows ?? []).length})
                </button>
                {!collapsed
                  ? otherRows.map((row, i) => renderRow(row, favoriteRows.length + i))
                  : null}
              </>
            )}
          </div>

          {showEffort || showSpeed ? (
            <div className="chunky-model-footer">
              {showEffort
                ? renderKnobs("Reasoning effort", EFFORTS, model?.effort, (v) => setEffort(v as Effort))
                : null}
              {showSpeed
                ? renderKnobs("Speed", SPEEDS, model?.speed ?? "standard", (v) => setSpeed(v as Speed))
                : null}
            </div>
          ) : null}

          {saveError ? <div className="chunky-model-error">{saveError}</div> : null}
          {busy ? <div className="chunky-model-note">Saving…</div> : null}
        </div>
      ) : null}
    </div>
  )
}
