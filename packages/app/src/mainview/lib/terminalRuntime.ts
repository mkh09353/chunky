// Module-level terminal registry — deliberately OUTSIDE React.
//
// A terminal is a live PTY on the bun side plus an xterm.js instance holding
// thousands of lines of scrollback. React unmounts a pane whenever you switch
// tabs, so if the xterm lived in component state every tab switch would nuke
// the screen (and, worse, tempt us into killing the process). Instead each
// terminal owns a DETACHED <div> parked in an offscreen holder; showing a
// terminal only re-parents that div into the visible mount point. Nothing is
// ever disposed on a tab switch — only on an explicit close.
//
// The bun side pushes `{ type: "terminal-event", event }` messages; one global
// dispatcher (installed lazily on first use) routes them by terminalId.

import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import { Unicode11Addon } from "@xterm/addon-unicode11"
import { SearchAddon } from "@xterm/addon-search"
import "@xterm/xterm/css/xterm.css"
import type {
  TerminalEvent,
  TerminalInfo,
  TerminalOpenResult,
} from "../../shared/terminal"
import { getRpc, nativeRpcAvailable } from "./rpc"

/** Max chars per terminalWrite — the bun handler rejects anything larger. */
const MAX_WRITE_CHARS = 65536

export type TerminalEntry = {
  term: Terminal
  fit: FitAddon
  search: SearchAddon
  container: HTMLDivElement
  info: TerminalInfo
}

const registry = new Map<string, TerminalEntry>()

// Terminals whose `terminalOpen` round-trip hasn't resolved yet. Live output
// can race ahead of the snapshot, and replaying it in the wrong order would
// scramble the screen — so we park events here and flush once the snapshot has
// been written.
const pending = new Map<string, TerminalEvent[]>()

// ---- subscribers (React reads tab titles/status from here) ----

type Listener = () => void
const listeners = new Set<Listener>()

export function subscribeTerminals(fn: Listener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

// useSyncExternalStore requires a STABLE snapshot reference — returning a fresh
// array every call would loop forever. Rebuilt only when something changes.
let snapshotCache: TerminalInfo[] = []
export function getTerminalsSnapshot(): TerminalInfo[] {
  return snapshotCache
}

function emit() {
  snapshotCache = [...registry.values()].map((e) => e.info)
  for (const fn of listeners) fn()
}

export function getEntry(terminalId: string): TerminalEntry | undefined {
  return registry.get(terminalId)
}

// ---- offscreen holder ----

// xterm measures character cells from real layout, so a container that has
// never been in the DOM reports 0×0 and `fit()` computes nonsense. Park hidden
// terminals in a sized, offscreen (not `display:none`) holder so they always
// have geometry to measure against.
let holder: HTMLDivElement | null = null
function getHolder(): HTMLDivElement {
  if (!holder) {
    holder = document.createElement("div")
    holder.className = "chunky-term-holder"
    holder.setAttribute("aria-hidden", "true")
    document.body.appendChild(holder)
  }
  return holder
}

/** Park a terminal's container back offscreen (keeps it alive and measurable). */
export function detachTerminal(terminalId: string): void {
  const entry = registry.get(terminalId)
  if (entry) getHolder().appendChild(entry.container)
}

/** Re-parent a terminal's container into a visible mount point. */
export function attachTerminal(terminalId: string, mount: HTMLElement): void {
  const entry = registry.get(terminalId)
  if (!entry) return
  if (entry.container.parentElement !== mount) mount.appendChild(entry.container)
}

// ---- theme ----

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

// Derived from the app's design tokens so terminals match the shell in both
// dark and light mode, with dark-ish fallbacks if a token is missing.
function currentTheme() {
  return {
    background: cssVar("--color-background-surface", "#0b0d10"),
    foreground: cssVar("--color-text-primary", "#e6e6e6"),
    cursor: cssVar("--color-text-primary", "#e6e6e6"),
    selectionBackground: cssVar("--color-background-selected", "#264f78"),
  }
}

/** Re-derive every live terminal's theme (called when the app theme flips). */
export function refreshTerminalThemes(): void {
  const theme = currentTheme()
  for (const entry of registry.values()) entry.term.options.theme = theme
}

// ---- push-event dispatcher ----

let dispatcherInstalled = false

function extractEvent(payload: unknown): TerminalEvent | null {
  if (!payload || typeof payload !== "object") return null
  const p = payload as { type?: unknown; event?: unknown; kind?: unknown }
  // Contract shape: { type: "terminal-event", event: TerminalEvent }.
  if (p.type === "terminal-event" && p.event && typeof p.event === "object") {
    return p.event as TerminalEvent
  }
  // Tolerate a bare TerminalEvent payload (message name already namespaced it).
  if (typeof p.kind === "string" && typeof (p as { terminalId?: unknown }).terminalId === "string") {
    return p as unknown as TerminalEvent
  }
  return null
}

async function installDispatcher(): Promise<void> {
  if (dispatcherInstalled) return
  dispatcherInstalled = true
  const rpc = await getRpc()
  // Wildcard: we don't control the message name bun sends under, only the
  // payload shape, so filter on the payload instead.
  rpc?.addMessageListener?.("*", (...args: unknown[]) => {
    // Wildcard listeners get (messageName, payload); named ones get (payload).
    for (const arg of args) {
      const event = extractEvent(arg)
      if (event) {
        handleEvent(event)
        return
      }
    }
  })
}

const encoder = new TextEncoder()

function handleEvent(event: TerminalEvent): void {
  // Still waiting on the snapshot — queue rather than interleave.
  const queue = pending.get(event.terminalId)
  if (queue) {
    queue.push(event)
    return
  }
  applyEvent(event)
}

function applyEvent(event: TerminalEvent): void {
  const entry = registry.get(event.terminalId)
  if (!entry) return
  if (event.kind === "output") {
    // Ack AFTER xterm has actually consumed the chunk — the bun side throttles
    // the PTY read loop on these acks, so a missed one stalls the terminal.
    entry.term.write(event.data, () => {
      void callRpc("terminalAck", {
        terminalId: event.terminalId,
        bytes: encoder.encode(event.data).length,
      })
    })
    return
  }
  if (event.kind === "started") {
    entry.info = { ...entry.info, status: "running", pid: event.pid }
    emit()
    return
  }
  if (event.kind === "exited") {
    entry.info = { ...entry.info, status: "exited", exitCode: event.exitCode }
    const code = event.exitCode ?? 0
    entry.term.write(`\r\n\x1b[2m[process exited (code ${code})]\x1b[0m\r\n`)
    emit()
  }
}

// ---- rpc plumbing ----

async function callRpc<T>(method: string, arg?: unknown): Promise<T | null> {
  try {
    const rpc = await getRpc()
    const fn = rpc?.request?.[method]
    if (!fn) return null
    return (await fn(arg)) as T
  } catch {
    return null
  }
}

// ---- lifecycle ----

function createEntry(terminalId: string, title: string, cwd: string): TerminalEntry {
  const container = document.createElement("div")
  container.className = "chunky-term-instance"

  const term = new Terminal({
    cursorBlink: true,
    scrollback: 5000,
    allowProposedApi: true,
    fontFamily:
      'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
    fontSize: 13,
    theme: currentTheme(),
  })

  const fit = new FitAddon()
  const search = new SearchAddon()
  term.loadAddon(fit)
  term.loadAddon(search)
  const unicode11 = new Unicode11Addon()
  term.loadAddon(unicode11)
  // Wide/emoji glyphs measure correctly only once the v11 tables are active.
  term.unicode.activeVersion = "11"

  // Mount once, offscreen. From here on the container only ever moves between
  // the holder and a visible pane — `open()` is never called again.
  getHolder().appendChild(container)
  term.open(container)

  term.onData((data) => {
    // The bun handler caps a single write at 65536 chars (a paste of a large
    // file can exceed that in one event), so slice into contract-sized chunks.
    for (let i = 0; i < data.length; i += MAX_WRITE_CHARS) {
      void callRpc("terminalWrite", {
        terminalId,
        data: data.slice(i, i + MAX_WRITE_CHARS),
      })
    }
  })

  const info: TerminalInfo = {
    terminalId,
    title,
    cwd,
    status: "running",
    pid: null,
    exitCode: null,
  }
  const entry: TerminalEntry = { term, fit, search, container, info }
  registry.set(terminalId, entry)
  return entry
}

/**
 * Create (or return) a live terminal. Idempotent per terminalId, so a React
 * StrictMode double-effect or a re-render can't spawn two shells.
 */
export async function openTerminal(opts: {
  terminalId: string
  title: string
  cwd?: string
}): Promise<TerminalEntry | null> {
  if (!nativeRpcAvailable()) return null
  const existing = registry.get(opts.terminalId)
  if (existing) return existing

  await installDispatcher()

  const entry = createEntry(opts.terminalId, opts.title, opts.cwd ?? "")
  pending.set(opts.terminalId, [])
  emit()

  try {
    entry.fit.fit()
  } catch {
    /* not laid out yet — the pane's ResizeObserver will fit shortly */
  }

  const result = await callRpc<TerminalOpenResult>("terminalOpen", {
    terminalId: opts.terminalId,
    cwd: opts.cwd,
    cols: entry.term.cols,
    rows: entry.term.rows,
  })

  if (!result?.ok) {
    const message = result?.error ?? "failed to start terminal"
    entry.term.write(`\r\n\x1b[2m[${message}]\x1b[0m\r\n`)
    entry.info = { ...entry.info, status: "exited" }
  } else {
    if (result.info) entry.info = { ...result.info, title: entry.info.title }
    // Replay buffered scrollback before any live output lands.
    if (result.snapshot) entry.term.write(result.snapshot)
  }

  // Drain anything that arrived during the round-trip, then go live.
  const queued = pending.get(opts.terminalId) ?? []
  pending.delete(opts.terminalId)
  for (const event of queued) applyEvent(event)
  emit()
  return entry
}

/**
 * Adopt a terminal that bun already has running (webview reloads in dev drop
 * the whole registry while the PTYs survive). Rebuilds the xterm and replays
 * the server-side snapshot.
 */
export async function adoptTerminal(info: TerminalInfo, title: string): Promise<void> {
  if (registry.has(info.terminalId)) return
  await installDispatcher()

  const entry = createEntry(info.terminalId, title, info.cwd)
  entry.info = { ...info, title }
  pending.set(info.terminalId, [])
  emit()

  try {
    entry.fit.fit()
  } catch {
    /* laid out by the pane */
  }

  // terminalOpen on an existing id is the reattach path: bun returns the
  // existing session plus its snapshot rather than spawning a second shell.
  const result = await callRpc<TerminalOpenResult>("terminalOpen", {
    terminalId: info.terminalId,
    cwd: info.cwd,
    cols: entry.term.cols,
    rows: entry.term.rows,
  })
  if (result?.ok) {
    if (result.info) entry.info = { ...result.info, title }
    if (result.snapshot) entry.term.write(result.snapshot)
  }

  const queued = pending.get(info.terminalId) ?? []
  pending.delete(info.terminalId)
  for (const event of queued) applyEvent(event)
  emit()
}

/** List terminals bun still has running (used to restore tabs on load). */
export async function listRunningTerminals(): Promise<TerminalInfo[]> {
  if (!nativeRpcAvailable()) return []
  const list = await callRpc<TerminalInfo[]>("terminalList")
  return Array.isArray(list) ? list : []
}

/** Explicit close — the ONLY path that disposes the xterm and kills the PTY. */
export function closeTerminal(terminalId: string): void {
  const entry = registry.get(terminalId)
  registry.delete(terminalId)
  pending.delete(terminalId)
  emit()
  if (!entry) return
  void callRpc("terminalClose", { terminalId })
  try {
    entry.term.dispose()
  } catch {
    /* already gone */
  }
  entry.container.remove()
}

/** Resize the PTY to match xterm's current geometry. */
export function resizeTerminal(terminalId: string, cols: number, rows: number): void {
  void callRpc("terminalResize", { terminalId, cols, rows })
}
