import { useEffect, useMemo, useState } from "react"
import { TextAttributes } from "@opentui/core"
import { ACCENT, BORDER } from "../theme.js"
import { rawModeSupported, useInput } from "../useInput.js"

export interface SkillCatalogRow { name: string; description: string; source: "user" | "project" | "repo"; sourceLabel: string; path: string; enabled: boolean }
type Item = { kind: "group"; label: string; key: string } | { kind: "skill"; skill: SkillCatalogRow; key: string }
const WINDOW = 14

function fuzzy(q: string, text: string): boolean {
  let i = 0
  for (const c of q.toLowerCase()) { i = text.toLowerCase().indexOf(c, i); if (i < 0) return false; i++ }
  return true
}

export function SkillsPicker({ baseUrl, sessionId, onSelect, onCancel }: { baseUrl: string; sessionId: string | null; onSelect: (name: string) => void; onCancel: () => void }) {
  const [skills, setSkills] = useState<SkillCatalogRow[]>([])
  const [query, setQuery] = useState("")
  const [selected, setSelected] = useState(0)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const refresh = async () => {
    const q = sessionId ? `?session=${encodeURIComponent(sessionId)}` : ""
    const res = await fetch(`${baseUrl}/api/skills${q}`)
    const body = await res.json() as { skills?: SkillCatalogRow[] }
    setSkills(body.skills ?? [])
  }
  useEffect(() => { void refresh().catch(() => {}) }, [sessionId])
  const visibleSkills = useMemo(() => query ? skills.filter(s => fuzzy(query, `${s.name} ${s.description} ${s.sourceLabel}`)) : skills, [skills, query])
  const groups = useMemo(() => {
    const map = new Map<string, SkillCatalogRow[]>()
    for (const s of visibleSkills) { const label = s.source === "user" ? "User" : s.source === "project" ? "Project" : s.sourceLabel; map.set(label, [...(map.get(label) ?? []), s]) }
    return [...map.entries()].sort((a, b) => (a[0] === "User" ? -2 : a[0] === "Project" ? -1 : 0) - (b[0] === "User" ? -2 : b[0] === "Project" ? -1 : 0) || a[0].localeCompare(b[0]))
  }, [visibleSkills])
  const items = useMemo<Item[]>(() => groups.flatMap(([label, rows]) => {
    const key = label
    return [{ kind: "group" as const, label, key }, ...(collapsed[key] && !query ? [] : rows.map(skill => ({ kind: "skill" as const, skill, key: `${label}:${skill.name}` })))]
  }), [groups, collapsed, query])
  useInput((input, key) => {
    if (key.escape) return onCancel()
    if (key.upArrow) return setSelected(n => Math.max(0, n - 1))
    if (key.downArrow) return setSelected(n => Math.min(Math.max(0, items.length - 1), n + 1))
    const item = items[selected]
    if ((key.leftArrow || key.rightArrow || key.return) && item?.kind === "group") { setCollapsed(c => ({ ...c, [item.key]: key.leftArrow ? true : key.rightArrow ? false : !c[item.key] })); return }
    if (input === " " && item?.kind === "skill") {
      const skill = item.skill; const next = !skill.enabled; setSkills(xs => xs.map(x => x.name === skill.name && x.sourceLabel === skill.sourceLabel ? { ...x, enabled: next } : x)); setBusy(skill.name)
      void fetch(`${baseUrl}/api/skills`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: next ? "enable" : "disable", name: skill.name, ...(skill.source === "repo" ? { repoId: skill.sourceLabel.slice("repo:".length) } : {}) }) }).then(() => refresh()).catch(() => refresh()).finally(() => setBusy(null)); return
    }
    if (key.return && item?.kind === "skill") return onSelect(item.skill.name)
    if (input && input >= " " && !key.ctrl && !key.meta) { setQuery(q => q + input); setSelected(0) }
    if (key.backspace) { setQuery(q => q.slice(0, -1)); setSelected(0) }
  }, { isActive: rawModeSupported })
  const start = Math.max(0, Math.min(selected - 6, items.length - WINDOW))
  return <box flexDirection="column" border borderStyle="rounded" borderColor={BORDER} paddingX={1} marginBottom={1}>
    <text attributes={TextAttributes.DIM}>Skills — ↑/↓ move · enter run/toggle group · space toggle · esc close {query ? `· filter: ${query}` : ""}</text>
    {items.slice(start, start + WINDOW).map((item, i) => { const on = start + i === selected; if (item.kind === "group") return <text key={item.key} fg={on ? ACCENT : undefined} attributes={on ? TextAttributes.BOLD : 0}>{`${on ? "❯ " : "  "}${item.label} ${collapsed[item.key] && !query ? "▸" : "▾"}`}</text>; const d = item.skill.description.replace(/\s+/g, " "); return <text key={item.key} fg={on ? ACCENT : undefined} attributes={!item.skill.enabled ? TextAttributes.DIM : 0}>{`${on ? "❯ " : "  "}${item.skill.enabled ? "on " : "off"} ${item.skill.name} — ${d.length > 48 ? d.slice(0, 47) + "…" : d}${busy === item.skill.name ? " …" : ""}`}</text> })}
  </box>
}
