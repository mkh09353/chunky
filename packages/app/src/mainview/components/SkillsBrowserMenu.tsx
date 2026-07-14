import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ChevronDownIcon, ChevronRightIcon, SparklesIcon } from "@heroicons/react/24/outline"
import { getSkills, toggleSkill, type SkillCatalogEntry } from "../lib/api"

/** Case-insensitive subsequence match (same shape as the TUI's /skills filter):
 *  every query char must appear in order somewhere in the target. */
function fuzzy(query: string, target: string): boolean {
  if (!query) return true
  const q = query.toLowerCase()
  const t = target.toLowerCase()
  let i = 0
  for (const c of q) {
    i = t.indexOf(c, i)
    if (i < 0) return false
    i++
  }
  return true
}

/** The group header a skill lands under: User / Project surface first, then each
 *  managed repo keeps its "repo:<id>" label. */
function groupLabel(s: SkillCatalogEntry): string {
  return s.source === "user" ? "User" : s.source === "project" ? "Project" : s.sourceLabel
}
function groupRank(label: string): number {
  return label === "User" ? -2 : label === "Project" ? -1 : 0
}

type NavItem =
  | { kind: "group"; label: string; key: string }
  | { kind: "skill"; skill: SkillCatalogEntry; key: string }

/**
 * The composer's human-facing skills browser (the app's /skills with no args),
 * mirroring the TUI's SkillsPicker. A quiet "Skills" trigger next to the model
 * picker opens an upward popover: skills grouped by source under collapsible
 * headers (User, Project, then each repo). Typing fuzzy-filters across every
 * group (and auto-expands while filtering). Each row carries an enabled toggle
 * (click or Space) that persists via POST /api/skills with an optimistic flip;
 * clicking/Enter on a skill SELECTS it (attaches it to the next message) and
 * closes. Reuses the chunky-model-* styles so it reads as one family with the
 * model/advisor pickers.
 */
export function SkillsBrowserMenu({
  baseUrl,
  sessionId,
  onSelect,
  openSignal,
}: {
  baseUrl: string
  sessionId: string | null
  onSelect: (name: string) => void
  /** Bump to open the menu programmatically (the /skills command). */
  openSignal?: number
}) {
  const [open, setOpen] = useState(false)
  const [skills, setSkills] = useState<SkillCatalogEntry[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const [filter, setFilter] = useState("")
  const [listSel, setListSel] = useState(0)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const close = useCallback(() => setOpen(false), [])

  const refresh = useCallback(async () => {
    try {
      const rows = await getSkills(baseUrl, sessionId)
      setSkills(rows)
      setLoadError(null)
    } catch (err) {
      setLoadError((err as Error).message)
    }
  }, [baseUrl, sessionId])

  const openMenu = useCallback(() => {
    setFilter("")
    setListSel(0)
    setOpen(true)
    setLoadError(null)
    // Always re-fetch on open so newly added repos / toggles from elsewhere show.
    void refresh()
  }, [refresh])

  // The /skills slash command bumps openSignal to open the menu from outside.
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

  const searching = filter.trim().length > 0

  const visibleSkills = useMemo(() => {
    const all = skills ?? []
    if (!searching) return all
    return all.filter((s) => fuzzy(filter, `${s.name} ${s.description} ${s.sourceLabel}`))
  }, [skills, filter, searching])

  const groups = useMemo(() => {
    const map = new Map<string, SkillCatalogEntry[]>()
    for (const s of visibleSkills) {
      const label = groupLabel(s)
      map.set(label, [...(map.get(label) ?? []), s])
    }
    return [...map.entries()].sort(
      (a, b) => groupRank(a[0]) - groupRank(b[0]) || a[0].localeCompare(b[0]),
    )
  }, [visibleSkills])

  // Flattened render/keyboard-nav order: a group header, then its rows unless
  // it's collapsed (filtering forces every group open so no match hides).
  const navItems = useMemo<NavItem[]>(
    () =>
      groups.flatMap(([label, rows]) => {
        const header: NavItem = { kind: "group", label, key: `g:${label}` }
        if (collapsed[label] && !searching) return [header]
        return [
          header,
          ...rows.map<NavItem>((skill) => ({
            kind: "skill",
            skill,
            key: `s:${label}:${skill.name}`,
          })),
        ]
      }),
    [groups, collapsed, searching],
  )

  useEffect(() => {
    setListSel((s) => (navItems.length === 0 ? 0 : Math.min(s, navItems.length - 1)))
  }, [navItems.length])

  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" })
  }, [listSel, navItems.length])

  const toggle = useCallback(
    (skill: SkillCatalogEntry) => {
      const next = !skill.enabled
      // Optimistic flip on the matching row (name + sourceLabel is unique).
      setSkills((xs) =>
        (xs ?? []).map((x) =>
          x.name === skill.name && x.sourceLabel === skill.sourceLabel
            ? { ...x, enabled: next }
            : x,
        ),
      )
      setBusy(skill.name)
      void toggleSkill(baseUrl, {
        action: next ? "enable" : "disable",
        name: skill.name,
        ...(skill.source === "repo" ? { repoId: skill.sourceLabel.slice("repo:".length) } : {}),
      })
        .then(() => refresh())
        .catch(() => refresh())
        .finally(() => setBusy(null))
    },
    [baseUrl, refresh],
  )

  const toggleGroup = useCallback(
    (label: string, force?: boolean) =>
      setCollapsed((c) => ({ ...c, [label]: force ?? !c[label] })),
    [],
  )

  const selectSkill = useCallback(
    (name: string) => {
      onSelect(name)
      close()
    },
    [onSelect, close],
  )

  const activate = useCallback(
    (idx: number) => {
      const item = navItems[idx]
      if (!item) return
      if (item.kind === "group") toggleGroup(item.label)
      else selectSkill(item.skill.name)
    },
    [navItems, toggleGroup, selectSkill],
  )

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault()
        e.stopPropagation()
        close()
        return
      }
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault()
        e.stopPropagation()
        const delta = e.key === "ArrowDown" ? 1 : -1
        setListSel((s) => Math.min(Math.max(0, s + delta), Math.max(0, navItems.length - 1)))
        return
      }
      const item = navItems[listSel]
      if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && item?.kind === "group") {
        e.preventDefault()
        e.stopPropagation()
        toggleGroup(item.label, e.key === "ArrowLeft")
        return
      }
      if (e.key === " ") {
        // Space never types into the filter — it toggles the active skill.
        e.preventDefault()
        e.stopPropagation()
        if (item?.kind === "skill") toggle(item.skill)
        return
      }
      if (e.key === "Enter") {
        e.preventDefault()
        e.stopPropagation()
        activate(listSel)
      }
    },
    [close, navItems, listSel, toggleGroup, toggle, activate],
  )

  const renderGroup = (item: Extract<NavItem, { kind: "group" }>, idx: number) => {
    const isCollapsed = Boolean(collapsed[item.label]) && !searching
    return (
      <button
        key={item.key}
        type="button"
        className="chunky-skill-group"
        aria-expanded={!isCollapsed}
        data-active={idx === listSel || undefined}
        onMouseEnter={() => setListSel(idx)}
        onClick={() => toggleGroup(item.label)}
      >
        {isCollapsed ? (
          <ChevronRightIcon aria-hidden="true" />
        ) : (
          <ChevronDownIcon aria-hidden="true" />
        )}
        {item.label}
      </button>
    )
  }

  const renderSkill = (item: Extract<NavItem, { kind: "skill" }>, idx: number) => {
    const skill = item.skill
    const desc = skill.description.replace(/\s+/g, " ").trim()
    return (
      <button
        key={item.key}
        type="button"
        role="option"
        aria-selected={idx === listSel}
        className="chunky-model-row chunky-skill-row"
        data-active={idx === listSel || undefined}
        data-disabled={!skill.enabled || undefined}
        title={desc || skill.name}
        onMouseEnter={() => setListSel(idx)}
        onClick={() => selectSkill(skill.name)}
      >
        <span
          role="button"
          tabIndex={-1}
          className={`chunky-skill-toggle${skill.enabled ? " chunky-skill-toggle-on" : ""}`}
          aria-label={skill.enabled ? `Disable ${skill.name}` : `Enable ${skill.name}`}
          aria-pressed={skill.enabled}
          title={skill.enabled ? "Enabled — click to disable" : "Disabled — click to enable"}
          onClick={(e) => {
            e.stopPropagation()
            toggle(skill)
          }}
        >
          {skill.enabled ? "on" : "off"}
        </span>
        <span className="chunky-model-row-name">
          {skill.name}
          {desc ? <span className="chunky-skill-desc"> — {desc}</span> : null}
        </span>
        {busy === skill.name ? <span className="chunky-model-row-hint">…</span> : null}
      </button>
    )
  }

  return (
    <div className="chunky-model-pick" ref={rootRef}>
      <button
        type="button"
        className="chunky-model-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Browse skills — pick one to attach to your next message"
        onClick={() => (open ? close() : openMenu())}
      >
        <SparklesIcon className="chunky-model-trigger-chevron" aria-hidden="true" />
        <span className="chunky-model-trigger-name">Skills</span>
      </button>

      {open ? (
        <div
          className="chunky-model-menu"
          role="dialog"
          aria-label="Browse skills"
          onKeyDown={handleKeyDown}
          onClick={(e) => e.stopPropagation()}
        >
          <input
            ref={inputRef}
            className="chunky-model-filter"
            type="text"
            value={filter}
            spellCheck={false}
            placeholder="Search skills…"
            onChange={(e) => {
              setFilter(e.target.value)
              setListSel(0)
            }}
          />

          <div className="chunky-model-list" ref={listRef} role="listbox">
            {skills === null && !loadError ? (
              <div className="chunky-model-note">Loading skills…</div>
            ) : loadError ? (
              <div className="chunky-model-error">Couldn&apos;t load skills: {loadError}</div>
            ) : navItems.length === 0 ? (
              <div className="chunky-model-note">
                {searching ? "No matches" : "No skills found. Add a pack with /skills add <git-url>."}
              </div>
            ) : (
              navItems.map((item, i) =>
                item.kind === "group" ? renderGroup(item, i) : renderSkill(item, i),
              )
            )}
          </div>

          <div className="chunky-model-note">
            Enter attaches a skill to your next message · Space toggles on/off
          </div>
        </div>
      ) : null}
    </div>
  )
}
