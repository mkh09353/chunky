// @chunky/protocol/relay-client — the phone side of the relay tunnel. One
// WebSocket to the relay carries the plaintext relay frames from ./relay.ts;
// their payloads are E2E ciphertext for exactly one paired computer, and on
// top of that tunnel this exposes fetch()/sse() mirroring the server's ROUTES
// contract, so a remote UI is written exactly like a local one. Portable by
// design: native WebSocket + TextEncoder/TextDecoder + crypto.randomUUID only
// (no Bun/Node APIs, no fetch() — every byte rides the socket), so it runs in
// browsers and in JavaScriptCore inside the iPhone app, for which this is the
// reference implementation. See docs/relay-design.md.

import { RELAY_WS_PATH } from "./relay.ts"
import type { PeerInfo, RelayClientFrame, RelayServerFrame, TunnelFrame } from "./relay.ts"
import { fromB64, openJSON, sealJSON, toB64 } from "./relay-crypto.ts"
import { readSSE } from "./index.ts"
import type { AgentEvent } from "./index.ts"

/** How long connect() waits for the relay's hello.ok before rejecting. */
const HELLO_TIMEOUT_MS = 10_000

export interface RelayClientOptions {
  /** Relay base URL (http/https — mapped to ws/wss + the /ws path). */
  relayUrl: string
  /** This phone's device token from pairing (POST /pair/claim). */
  deviceToken: string
  /** The paired computer's device id — the only peer this client talks to. */
  peerDeviceId: string
  /** deriveSharedKey(computerPubKey, phoneSecretKey): the per-frame E2E key. */
  sharedKey: Uint8Array
  /** Peer online/offline transitions, straight from relay presence frames. */
  onPresence?: (deviceId: string, online: boolean) => void
  /** Fired once when the connection ends — "closed" after close(), otherwise
   *  why the socket dropped. No auto-reconnect in v1: callers reconnect by
   *  calling RelayClient.connect() again. */
  onClose?: (reason: string) => void
}

/** Request options for RelayClient.fetch — the subset of RequestInit the
 *  tunnel carries. An object body is JSON-encoded (and content-type set). */
export interface TunnelRequestInit {
  method?: string
  headers?: Record<string, string>
  body?: string | object
}

/** A buffered tunnel response. The base64 body is decoded once, lazily. */
export interface TunnelResponse {
  status: number
  headers: Record<string, string>
  text(): string
  json<T = unknown>(): T
}

/** What an in-flight request id maps to: a fetch() waiting for one buffered
 *  http.res, or an sse() feeding chunk bytes into a ReadableStream. */
type PendingEntry =
  | { kind: "fetch"; resolve: (res: TunnelResponse) => void; reject: (err: Error) => void }
  | {
      kind: "sse"
      controller: ReadableStreamDefaultController<Uint8Array>
      /** Resolves the generator's wait once http.res.start arrives. */
      start: (frame: { status: number; headers?: Record<string, string> }) => void
      /** Rejects that wait (buffered error response / connection gone). */
      fail: (err: Error) => void
      /** True once the stream finished or the socket died — suppresses the
       *  pointless http.cancel on generator exit. */
      ended: boolean
    }

/**
 * The phone-side relay client. Obtain one via RelayClient.connect(); when the
 * connection drops, onClose fires and the instance is dead — reconnect with a
 * fresh connect() (the relay's store-and-forward buffer replays anything the
 * phone missed while offline).
 */
export class RelayClient {
  private readonly opts: RelayClientOptions
  private readonly ws: WebSocket
  private peerList: PeerInfo[] = []
  /** Highest relay seq seen by this instance, offered as hello.lastSeq so the
   *  relay replays only what we missed. Every recv is also acked immediately,
   *  which trims the relay's buffer as we go. */
  private lastSeq: number | undefined
  private readonly pending = new Map<string, PendingEntry>()
  private closed = false

  private constructor(opts: RelayClientOptions, ws: WebSocket) {
    this.opts = opts
    this.ws = ws
  }

  /** Open the socket, authenticate with the device token, and resolve once
   *  the relay accepts us (hello.ok, with the account's peer list). Rejects
   *  on an error frame, socket failure, or a 10 s hello timeout. */
  static connect(opts: RelayClientOptions): Promise<RelayClient> {
    // http(s) base -> ws(s) endpoint: https://relay.chunky.to -> wss://…/ws
    const wsUrl = opts.relayUrl.replace(/\/+$/, "").replace(/^http/, "ws") + RELAY_WS_PATH
    const ws = new WebSocket(wsUrl)
    const client = new RelayClient(opts, ws)
    return new Promise<RelayClient>((resolve, reject) => {
      let connected = false
      const fail = (err: Error) => {
        if (connected || client.closed) return
        client.closed = true // dead before it was ever handed out — no onClose
        clearTimeout(timer)
        try {
          ws.close()
        } catch {
          /* already closing */
        }
        reject(err)
      }
      const timer = setTimeout(() => fail(new Error("relay-client: timed out waiting for hello.ok")), HELLO_TIMEOUT_MS)
      ws.onopen = () => client.send({ t: "hello", token: opts.deviceToken, lastSeq: client.lastSeq })
      ws.onerror = () => fail(new Error("relay-client: websocket error"))
      ws.onclose = (ev) => {
        if (!connected) fail(new Error(`relay-client: connection closed during hello (${ev.code})`))
        else client.teardown(`connection lost (${ev.code}${ev.reason ? `: ${ev.reason}` : ""})`)
      }
      ws.onmessage = (ev) => {
        const frame = decodeFrame(ev.data)
        if (!frame) return
        if (connected) {
          client.handleFrame(frame)
        } else if (frame.t === "hello.ok") {
          connected = true
          clearTimeout(timer)
          client.peerList = frame.peers
          resolve(client)
        } else if (frame.t === "error") {
          fail(new Error(`relay-client: ${frame.code}: ${frame.message}`))
        }
      }
    })
  }

  /** Devices on the account as of hello.ok, with live presence applied. */
  peers(): PeerInfo[] {
    return this.peerList.slice()
  }

  /** Tunnel one buffered HTTP request to the paired computer. A string body
   *  is sent as-is; an object body is JSON-encoded and content-type
   *  application/json is set (unless the caller already set one). Resolves
   *  with the peer's response once http.res comes back — which may be after a
   *  computer-offline gap, courtesy of the relay's store-and-forward buffer. */
  fetch(path: string, init?: TunnelRequestInit): Promise<TunnelResponse> {
    if (this.closed) return Promise.reject(new Error("relay-client: closed"))
    const id = crypto.randomUUID()
    const headers: Record<string, string> = { ...(init?.headers ?? {}) }
    let body: string | undefined
    if (typeof init?.body === "string") {
      body = toB64(new TextEncoder().encode(init.body))
    } else if (init?.body !== undefined) {
      body = toB64(new TextEncoder().encode(JSON.stringify(init.body)))
      if (!Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) {
        headers["content-type"] = "application/json"
      }
    }
    const req: TunnelFrame = {
      t: "http.req",
      id,
      method: init?.method ?? "GET",
      path,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
      ...(body !== undefined ? { body } : {}),
    }
    return new Promise<TunnelResponse>((resolve, reject) => {
      this.pending.set(id, { kind: "fetch", resolve, reject })
      try {
        this.sendTunnel(req)
      } catch (err) {
        this.pending.delete(id)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  /** Tunnel a streaming (SSE) GET and yield AgentEvents as they arrive. The
   *  peer's chunk bytes are fed into a ReadableStream wrapped as a Response,
   *  so ./index.ts's readSSE does the parsing — one SSE parser for local and
   *  relayed streams. Early return/throw (and close()) sends http.cancel so
   *  the uplink kills the upstream request. A buffered http.res instead of a
   *  stream (e.g. an error status) throws with that status. */
  async *sse(path: string): AsyncGenerator<AgentEvent> {
    if (this.closed) throw new Error("relay-client: closed")
    const id = crypto.randomUUID()
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const stream = new ReadableStream<Uint8Array>({
      start: (c) => {
        controller = c
      },
    })
    let start!: (frame: { status: number; headers?: Record<string, string> }) => void
    let fail!: (err: Error) => void
    const started = new Promise<{ status: number; headers?: Record<string, string> }>((res, rej) => {
      start = res
      fail = rej
    })
    const entry: PendingEntry = { kind: "sse", controller, start, fail, ended: false }
    this.pending.set(id, entry)
    try {
      this.sendTunnel({ t: "http.req", id, method: "GET", path })
      await started
      yield* readSSE(new Response(stream, { headers: { "content-type": "text/event-stream" } }))
    } finally {
      this.pending.delete(id)
      if (!entry.ended && !this.closed && this.ws.readyState === WebSocket.OPEN) {
        try {
          this.sendTunnel({ t: "http.cancel", id })
        } catch {
          /* socket raced shut — nothing left to cancel */
        }
      }
    }
  }

  /** Cancel every in-flight request (fetch promises reject, sse generators
   *  end), close the socket, and fire onClose("closed"). */
  close(): void {
    this.teardown("closed")
  }

  // ---- internals ----

  private handleFrame(frame: RelayServerFrame): void {
    switch (frame.t) {
      case "recv": {
        // Ack immediately: the relay deletes ≤ seq from our store-and-forward
        // buffer, and hello.lastSeq on a future connection resumes from here.
        try {
          this.send({ t: "ack", seq: frame.seq })
        } catch {
          /* socket raced shut */
        }
        if (this.lastSeq === undefined || frame.seq > this.lastSeq) this.lastSeq = frame.seq
        if (frame.from !== this.opts.peerDeviceId) return // not our paired computer
        let tunnel: TunnelFrame
        try {
          tunnel = openJSON<TunnelFrame>(frame.payload, this.opts.sharedKey)
        } catch {
          return // failed authentication — drop, never surface forged frames
        }
        this.handleTunnel(tunnel)
        return
      }
      case "presence": {
        const peer = this.peerList.find((p) => p.deviceId === frame.deviceId)
        if (peer) {
          peer.online = frame.online
          peer.lastSeen = Date.now()
        }
        this.opts.onPresence?.(frame.deviceId, frame.online)
        return
      }
      case "error": // fatal errors are followed by a close; nothing to route
      case "hello.ok": // already handled during connect
      case "pong":
        return
    }
  }

  private handleTunnel(frame: TunnelFrame): void {
    const entry = this.pending.get(frame.id)
    if (!entry) return // finished or cancelled request — stale frame
    switch (frame.t) {
      case "http.res":
        this.pending.delete(frame.id)
        if (entry.kind === "fetch") entry.resolve(tunnelResponse(frame))
        else entry.fail(new Error(`relay-client: HTTP ${frame.status} (buffered response, not a stream)`))
        return
      case "http.res.start":
        if (entry.kind === "sse") {
          entry.start(frame)
        } else {
          this.pending.delete(frame.id)
          entry.reject(new Error("relay-client: unexpected streaming response — use sse()"))
          try {
            this.sendTunnel({ t: "http.cancel", id: frame.id })
          } catch {
            /* socket raced shut */
          }
        }
        return
      case "http.res.chunk":
        if (entry.kind === "sse") {
          try {
            entry.controller.enqueue(fromB64(frame.data))
          } catch {
            /* stream already closed by the consumer */
          }
        }
        return
      case "http.res.end":
        if (entry.kind === "sse") {
          entry.ended = true
          this.pending.delete(frame.id)
          try {
            entry.controller.close()
          } catch {
            /* already closed */
          }
        }
        return
      case "http.req":
      case "http.cancel":
        return // computer -> phone requests are not a thing in v1
    }
  }

  /** Shared exit path for close() and a dropped socket: settle everything
   *  in flight, close the WS, fire onClose exactly once. */
  private teardown(reason: string): void {
    if (this.closed) return
    this.closed = true
    const err = new Error(`relay-client: ${reason}`)
    for (const entry of this.pending.values()) {
      if (entry.kind === "fetch") {
        entry.reject(err)
      } else {
        entry.ended = true // the socket is gone — nothing left to cancel
        entry.fail(err) // no-op if the stream already started
        try {
          entry.controller.close() // ends readSSE, so the generator returns
        } catch {
          /* already closed/errored */
        }
      }
    }
    this.pending.clear()
    try {
      this.ws.close()
    } catch {
      /* already closing */
    }
    this.opts.onClose?.(reason)
  }

  private send(frame: RelayClientFrame): void {
    if (this.ws.readyState !== WebSocket.OPEN) throw new Error("relay-client: socket is not open")
    this.ws.send(JSON.stringify(frame))
  }

  /** Seal a tunnel frame for the paired computer and route it via the relay. */
  private sendTunnel(frame: TunnelFrame): void {
    this.send({ t: "send", to: this.opts.peerDeviceId, payload: sealJSON(frame, this.opts.sharedKey) })
  }
}

/** Parse one relay WS message (text, or bytes from ws implementations that
 *  deliver binary) into a server frame; null for anything malformed. */
function decodeFrame(data: unknown): RelayServerFrame | null {
  let text: string
  if (typeof data === "string") text = data
  else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) text = new TextDecoder().decode(data as ArrayBuffer)
  else return null // e.g. a Blob — the relay only sends text frames
  try {
    return JSON.parse(text) as RelayServerFrame
  } catch {
    return null
  }
}

/** Wrap a buffered http.res as the caller-facing response. The base64 body
 *  is decoded to text at most once, on first use. */
function tunnelResponse(frame: { status: number; headers?: Record<string, string>; body?: string }): TunnelResponse {
  let text: string | undefined
  return {
    status: frame.status,
    headers: frame.headers ?? {},
    text() {
      if (text === undefined) text = frame.body ? new TextDecoder().decode(fromB64(frame.body)) : ""
      return text
    },
    json<T = unknown>(): T {
      return JSON.parse(this.text()) as T
    },
  }
}
