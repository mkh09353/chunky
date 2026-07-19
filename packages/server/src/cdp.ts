export interface CdpTarget { id: string; type: string; url?: string; title?: string; webSocketDebuggerUrl?: string; lastActivity?: number }
export interface CdpNode { nodeId?: number; backendDOMNodeId?: number; ignored?: boolean; role?: { value?: string }; name?: { value?: string }; value?: { value?: string }; properties?: Array<{ name?: string; value?: { value?: unknown } }>; childIds?: number[] }

export class CdpClient {
  private ws?: WebSocket
  private nextId = 0
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private listeners = new Map<string, Set<(params: any) => void>>()
  private generation = 0
  private refs = new Map<string, number>()
  private target?: CdpTarget
  private connecting = false
  constructor(private readonly baseUrl: string) {}
  get refGeneration() { return this.generation }
  setRefs(refs: Map<string, number>) { this.refs = refs; this.generation++ }
  ref(id: string) { return this.refs.get(id) }
  on(method: string, fn: (params: any) => void) { let s = this.listeners.get(method); if (!s) this.listeners.set(method, s = new Set()); s.add(fn); return () => s!.delete(fn) }
  async targets(): Promise<CdpTarget[]> { const r = await fetch(`${this.baseUrl}/json/list`); if (!r.ok) throw new Error(`CDP target discovery failed (${r.status})`); return await r.json() as CdpTarget[] }
  private async connect() {
    if (this.ws?.readyState === WebSocket.OPEN) return
    if (this.connecting) return
    this.connecting = true
    const targets = (await this.targets()).filter(t => t.type === "page" && t.webSocketDebuggerUrl)
    this.target = targets.sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0))[0]
    if (!this.target?.webSocketDebuggerUrl) { this.connecting = false; throw new Error("No browser page is open. Ask the user to open the browser pane (globe icon).") }
    const ws = new WebSocket(this.target.webSocketDebuggerUrl); this.ws = ws
    try { await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error("CDP connection timed out")), 5000); ws.onopen = () => { clearTimeout(timer); resolve() }; ws.onerror = () => { clearTimeout(timer); reject(new Error("CDP connection failed")) } }) } finally { this.connecting = false }
    ws.onmessage = e => { try { const m = JSON.parse(String(e.data)); if (m.id) { const p = this.pending.get(m.id); if (!p) return; clearTimeout(p.timer); this.pending.delete(m.id); m.error ? p.reject(new Error(m.error.message ?? "CDP error")) : p.resolve(m.result) } else if (m.method) for (const fn of this.listeners.get(m.method) ?? []) fn(m.params) } catch {} }
    ws.onclose = () => { this.ws = undefined; for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error("CDP connection closed")) }; this.pending.clear() }
    for (const domain of ["Page.enable", "Runtime.enable", "DOM.enable", "Accessibility.enable"]) await this.command(domain)
  }
  async command<T = any>(method: string, params?: unknown, timeout = 15000): Promise<T> { await this.connect(); const id = ++this.nextId; return await new Promise<T>((resolve, reject) => { const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP command timed out: ${method}`)) }, timeout); this.pending.set(id, { resolve, reject, timer }); this.ws!.send(JSON.stringify({ id, method, params })) }) }
  async close() { this.ws?.close(); this.ws = undefined }
}

export function validateHttpUrl(url: string): string | null { try { const u = new URL(url); return u.protocol === "http:" || u.protocol === "https:" ? null : "URL must use http or https" } catch { return "URL must be a valid http(s) URL" } }
export function interestingOutline(nodes: CdpNode[]): { text: string; refs: Map<string, number> } {
  const refs = new Map<string, number>(); let n = 0; const lines: string[] = []
  for (const node of nodes) { const role = String(node.role?.value ?? ""); const name = String(node.name?.value ?? ""); const value = node.value?.value ? ` value=${JSON.stringify(node.value.value)}` : ""; if (node.ignored || (!role && !name) || role === "generic") continue; const ref = node.backendDOMNodeId ? ` [e${++n}]` : ""; if (ref) refs.set(ref.slice(2, -1), node.backendDOMNodeId!); lines.push(`${"  ".repeat(Math.min(8, n ? 1 : 0))}${role || "node"} ${JSON.stringify(name)}${value}${ref}`) }
  return { text: lines.join("\n"), refs }
}
