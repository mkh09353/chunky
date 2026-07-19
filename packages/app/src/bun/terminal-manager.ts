import type {
  TerminalAckRequest,
  TerminalEvent,
  TerminalInfo,
  TerminalOpenRequest,
  TerminalOpenResult,
  TerminalResizeRequest,
  TerminalWriteRequest,
} from "../shared/terminal"

type Webview = { rpc?: { send?: (name: string, payload: unknown) => void } }
type Session = {
  info: TerminalInfo
  process: ReturnType<typeof Bun.spawn>
  terminal: Bun.Terminal
  decoder: TextDecoder
  history: string
  pending: string
  unacked: number
  watchdog: ReturnType<typeof setTimeout> | null
  killing: boolean
}

const MAX_HISTORY = 2 * 1024 * 1024
const MAX_UNACKED = 1024 * 1024
const MAX_WRITE = 65536
const MIN_COLS = 20
const MAX_COLS = 2000
const MIN_ROWS = 5
const MAX_ROWS = 1000
const encoder = new TextEncoder()

function clampSize(cols: number, rows: number): [number, number] {
  return [
    Math.min(MAX_COLS, Math.max(MIN_COLS, Math.floor(Number.isFinite(cols) ? cols : 80))),
    Math.min(MAX_ROWS, Math.max(MIN_ROWS, Math.floor(Number.isFinite(rows) ? rows : 24))),
  ]
}

function shell(): { command: string; args: string[] } {
  const selected = process.env.SHELL
  const command = selected && selected.startsWith("/") ? selected : ["/bin/zsh", "/bin/bash", "/bin/sh"].find((p) => { try { return Bun.file(p).size > 0 } catch { return false } }) ?? "/bin/sh"
  return { command, args: command === "/bin/sh" ? [] : ["-l"] }
}

function terminalEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value == null || /^(TERM|TERM_PROGRAM|TERM_PROGRAM_VERSION|GHOSTTY_|KITTY_|ITERM_|ITERM2_|LC_TERMINAL)/.test(key)) continue
    env[key] = value
  }
  env.TERM = "xterm-256color"
  env.COLORTERM = "truecolor"
  return env
}

export class TerminalManager {
  private readonly sessions = new Map<string, Session>()
  private webview: Webview | null = null
  constructor(private readonly defaultCwd: string) {}

  setWebview(webview: Webview): void { this.webview = webview }

  private emit(event: TerminalEvent): void {
    this.webview?.rpc?.send?.("terminal-event", { type: "terminal-event", event })
  }

  private appendHistory(session: Session, text: string): void {
    session.history += text
    if (session.history.length > MAX_HISTORY) session.history = session.history.slice(-MAX_HISTORY)
  }

  private sendOutput(session: Session, data: string): void {
    this.appendHistory(session, data)
    if (!data) return
    const bytes = encoder.encode(data).byteLength
    if (session.unacked + bytes > MAX_UNACKED) {
      session.pending += data
      this.armWatchdog(session)
      return
    }
    session.unacked += bytes
    this.emit({ kind: "output", terminalId: session.info.terminalId, data })
    this.armWatchdog(session)
  }

  private armWatchdog(session: Session): void {
    if (session.watchdog) clearTimeout(session.watchdog)
    session.watchdog = setTimeout(() => {
      session.unacked = 0
      session.watchdog = null
      this.drain(session)
    }, 5000)
  }

  private drain(session: Session): void {
    while (session.pending && session.unacked <= MAX_UNACKED) {
      const data = session.pending
      session.pending = ""
      session.unacked += encoder.encode(data).byteLength
      this.emit({ kind: "output", terminalId: session.info.terminalId, data })
    }
    if (session.unacked > 0) this.armWatchdog(session)
  }

  open(req: TerminalOpenRequest): TerminalOpenResult {
    const existing = this.sessions.get(req.terminalId)
    if (existing) return { ok: true, info: { ...existing.info }, snapshot: existing.history }
    const [cols, rows] = clampSize(req.cols, req.rows)
    const cwd = req.cwd || this.defaultCwd || process.env.HOME || process.cwd()
    try {
      const chosen = shell()
      const session = {} as Session
      const decoder = new TextDecoder("utf-8", { stream: true })
      const terminal = new Bun.Terminal({
        cols, rows, name: "xterm-256color",
        data: (_term, chunk) => {
          // Bun reuses callback buffers; decode immediately while preserving split UTF-8.
          const copy = new Uint8Array(chunk)
          this.sendOutput(session, decoder.decode(copy, { stream: true }))
        },
      })
      const proc = Bun.spawn([chosen.command, ...chosen.args], {
        cwd, env: terminalEnv(), terminal,
      })
      session.info = { terminalId: req.terminalId, title: chosen.command.split("/").pop() || "Terminal", cwd, status: "running", pid: proc.pid, exitCode: null }
      session.process = proc
      session.terminal = terminal
      session.decoder = decoder
      session.history = ""
      session.pending = ""
      session.unacked = 0
      session.watchdog = null
      session.killing = false
      this.sessions.set(req.terminalId, session)
      void proc.exited.then((code) => {
        if (session.info.status === "exited") return
        session.info.status = "exited"
        session.info.exitCode = code
        session.info.pid = null
        const tail = decoder.decode()
        if (tail) this.sendOutput(session, tail)
        this.emit({ kind: "exited", terminalId: req.terminalId, exitCode: code })
      })
      this.emit({ kind: "started", terminalId: req.terminalId, pid: proc.pid })
      return { ok: true, info: { ...session.info }, snapshot: "" }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  write(req: TerminalWriteRequest): boolean {
    if (typeof req.data !== "string" || req.data.length > MAX_WRITE) return false
    const session = this.sessions.get(req.terminalId)
    if (!session || session.info.status !== "running") return false
    try { session.terminal.write(req.data); return true } catch { return false }
  }

  resize(req: TerminalResizeRequest): boolean {
    const session = this.sessions.get(req.terminalId)
    if (!session || session.info.status !== "running") return false
    const [cols, rows] = clampSize(req.cols, req.rows)
    try { session.terminal.resize(cols, rows); return true } catch { return false }
  }

  ack(req: TerminalAckRequest): boolean {
    const session = this.sessions.get(req.terminalId)
    if (!session || !Number.isFinite(req.bytes) || req.bytes < 0) return false
    session.unacked = Math.max(0, session.unacked - Math.floor(req.bytes))
    this.drain(session)
    return true
  }

  close(terminalId: string): boolean {
    const session = this.sessions.get(terminalId)
    if (!session) return false
    session.killing = true
    try { session.process.kill("SIGTERM") } catch {}
    setTimeout(() => {
      if (session.info.status === "running") try { session.process.kill("SIGKILL") } catch {}
    }, 3000)
    this.sessions.delete(terminalId)
    try { session.terminal.close() } catch {}
    if (session.watchdog) clearTimeout(session.watchdog)
    return true
  }

  list(): TerminalInfo[] { return [...this.sessions.values()].map((s) => ({ ...s.info })) }

  cleanup(): void { for (const id of [...this.sessions.keys()]) this.close(id) }
}
