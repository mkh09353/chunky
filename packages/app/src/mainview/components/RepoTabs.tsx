import { useCallback, useEffect, useRef, useState } from "react"
import { TabList, Tab } from "@astryxdesign/core/TabList"
import { FolderIcon, PlusIcon, XMarkIcon } from "@heroicons/react/24/outline"
import type { Repo } from "../lib/api"
import { nativePickerAvailable, pickFolder } from "../lib/pickFolder"

/**
 * Repos as top-nav tabs: one Astryx Tab per repo (click to switch), a "+" that
 * opens an inline add form using the native OS folder picker when available
 * (packaged app) or a paste-a-path field otherwise. Each tab has a hover close
 * to remove it from the list (never deletes the folder).
 *
 * `busy` covers the NATIVE picker path: once a folder comes back from the OS
 * dialog, registering it is a server round-trip with no form to host a progress
 * hint (the paste-a-path form has its own `submitting` — "Adding…"). Without it
 * the "+" just sits there looking clickable while nothing appears to happen.
 */
export function RepoTabs({
  repos,
  activeId,
  onSelect,
  onAdd,
  onRemove,
  agentsMdEnabled,
  onToggleAgentsMd,
  busy,
}: {
  repos: Repo[]
  activeId: string | null
  onSelect: (id: string) => void
  onAdd: (path: string) => Promise<void>
  onRemove: (id: string) => void
  agentsMdEnabled?: boolean
  onToggleAgentsMd?: (enabled: boolean) => Promise<void>
  busy?: boolean
}) {
  const [adding, setAdding] = useState(false)
  const [path, setPath] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const closeAdd = useCallback(() => {
    setAdding(false)
    setPath("")
    setError(null)
  }, [])

  // Close the add popover on outside click / Escape.
  useEffect(() => {
    if (!adding) return
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) closeAdd()
    }
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closeAdd()
    document.addEventListener("mousedown", onDown)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", onDown)
      document.removeEventListener("keydown", onKey)
    }
  }, [adding, closeAdd])

  useEffect(() => {
    if (adding) inputRef.current?.focus()
  }, [adding])

  // Global tab switching (Codex/browser parity): Cmd+1…Cmd+9 jumps to the Nth
  // repo tab, and Cmd+Shift+[ / Cmd+Shift+] step to the previous/next tab,
  // wrapping at the ends. Guarded to bare Cmd (no Ctrl/Alt) so it can't collide
  // with the transcript's Ctrl+Shift+C / Ctrl+T or the native Cmd+C menu role.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || e.ctrlKey || e.altKey) return
      if (repos.length === 0) return
      // Cmd+Shift+[ / ] — prev/next by physical key (e.code is layout- and
      // shift-stable, unlike e.key which becomes "{"/"}" under Shift).
      if (e.shiftKey && (e.code === "BracketLeft" || e.code === "BracketRight")) {
        e.preventDefault()
        const idx = repos.findIndex((r) => r.id === activeId)
        const base = idx === -1 ? 0 : idx
        const delta = e.code === "BracketRight" ? 1 : -1
        const next = (base + delta + repos.length) % repos.length
        onSelect(repos[next]!.id)
        return
      }
      // Cmd+1…Cmd+9 — select the Nth tab (no-op past the last tab).
      if (!e.shiftKey && e.key >= "1" && e.key <= "9") {
        const n = Number(e.key) - 1
        if (n < repos.length) {
          e.preventDefault()
          onSelect(repos[n]!.id)
        }
      }
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [repos, activeId, onSelect])

  const add = useCallback(
    async (value: string) => {
      const trimmed = value.trim()
      if (!trimmed) {
        setError("Enter a folder path.")
        return
      }
      setSubmitting(true)
      setError(null)
      try {
        await onAdd(trimmed)
        closeAdd()
      } catch (err) {
        setError((err as Error).message || "Couldn't add that folder.")
      } finally {
        setSubmitting(false)
      }
    },
    [onAdd, closeAdd],
  )

  // "+" click: in the packaged app open the native OS folder chooser directly
  // (a real file selector). In a plain browser — which can't hand back an
  // absolute path — fall back to the paste-a-path form instead.
  const openAdd = useCallback(async () => {
    if (!nativePickerAvailable()) {
      setAdding((v) => !v)
      return
    }
    const picked = await pickFolder()
    if (!picked) return
    try {
      await onAdd(picked)
    } catch (err) {
      // Surface a bad pick in the form so the path can be corrected.
      setPath(picked)
      setError((err as Error).message || "Couldn't add that folder.")
      setAdding(true)
    }
  }, [onAdd])

  return (
    <div className="chunky-repotabs" ref={rootRef}>
      <TabList
        value={activeId ?? ""}
        onChange={(v) => onSelect(v)}
        size="sm"
        layout="hug"
      >
        {repos.map((r) => (
          <Tab
            key={r.id}
            value={r.id}
            label={r.name}
            icon={<FolderIcon style={{ width: 14, height: 14 }} />}
            endContent={
              repos.length > 1 ? (
                <span
                  className="chunky-repotab-close"
                  role="button"
                  tabIndex={0}
                  aria-label={`Remove ${r.name}`}
                  title={`Remove ${r.name} from the list`}
                  onClick={(e) => {
                    e.stopPropagation()
                    onRemove(r.id)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault()
                      e.stopPropagation()
                      onRemove(r.id)
                    }
                  }}
                >
                  <XMarkIcon style={{ width: 12, height: 12 }} />
                </span>
              ) : undefined
            }
          />
        ))}
      </TabList>

      <div className="chunky-repotab-addwrap">
        {activeId && onToggleAgentsMd && (
          <button
            type="button"
            className="chunky-repotab-add chunky-repotab-agents"
            aria-label={`${agentsMdEnabled === false ? "Enable" : "Disable"} AGENTS.md instructions`}
            title={`${agentsMdEnabled === false ? "Enable" : "Disable"} AGENTS.md instructions for this repository`}
            onClick={() => void onToggleAgentsMd(agentsMdEnabled === false)}
            disabled={busy}
          >
            {agentsMdEnabled === false ? "AGENTS off" : "AGENTS on"}
          </button>
        )}
        <button
          type="button"
          className="chunky-repotab-add"
          aria-label={busy ? "Adding a repo…" : "Add a repo"}
          title={busy ? "Adding a repo…" : "Add a repo"}
          onClick={() => void openAdd()}
          disabled={busy}
          aria-busy={busy || undefined}
        >
          {busy ? (
            <span className="chunky-repotab-spinner" aria-hidden="true" />
          ) : (
            <PlusIcon style={{ width: 16, height: 16 }} />
          )}
        </button>

        {adding ? (
          <div className="chunky-repo-menu chunky-repo-add-pop" role="dialog">
          <div className="chunky-repo-menu-label">Add a repo</div>
          <input
            ref={inputRef}
            className="chunky-repo-input"
            type="text"
            value={path}
            spellCheck={false}
            placeholder="/absolute/path/to/repo"
            onChange={(e) => setPath(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void add(path)}
            disabled={submitting}
          />
          {error ? <div className="chunky-repo-error">{error}</div> : null}
          <div className="chunky-repo-actions">
            <span style={{ flex: 1 }} />
            <button
              type="button"
              className="chunky-repo-btn"
              onClick={closeAdd}
              disabled={submitting}
            >
              Cancel
            </button>
            <button
              type="button"
              className="chunky-repo-btn chunky-repo-btn-primary"
              onClick={() => void add(path)}
              disabled={submitting}
            >
              {submitting ? "Adding…" : "Add"}
            </button>
          </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
