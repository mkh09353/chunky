// Relay uplink — the computer side of remote access (internal relay design doc).
//
// Dials OUT to the relay over WebSocket (so NAT/firewalls never matter) and
// acts as a pure sidecar: E2E-encrypted TunnelFrames from paired phones are
// decrypted, re-issued as plain HTTP against the local server on loopback, and
// the responses sealed back. Route handlers never know the relay exists.
//
// The relay is untrusted by design: every payload we hand it is sealJSON
// ciphertext under a per-peer X25519 shared key, and any frame that fails
// authentication is dropped. Log lines therefore never include payloads —
// only connection/presence/error facts.
//
// Dependency-free on purpose (native WebSocket + fetch, both built into Bun)
// so this file stays portable and auditable.
import {
  RELAY_WS_PATH,
  type RelayClientFrame,
  type RelayServerFrame,
  type TunnelFrame,
} from "@chunky/protocol/relay"
import { deriveSharedKey, fromB64, openJSON, sealJSON, toB64 } from "@chunky/protocol/relay-crypto"
import type { RelayConfig } from "./config.ts"
import { getServerToken } from "../settings.ts"

/** An in-flight local request, tracked so http.cancel / peer-offline / stop()
 *  can abort the fetch AND tear down its SSE reader (a dead phone must not
 *  leave us pumping chunks into its relay outbox forever). */
interface Inflight {
  ac: AbortController
  reader?: ReadableStreamDefaultReader<Uint8Array>
}

export function startUplink(opts: {
  config: RelayConfig
  localBaseUrl: string
  log?: (s: string) => void
}): { stop(): void } {
  const { config, localBaseUrl } = opts
  const log = opts.log ?? (() => {})

  // ECDH once per peer — every frame to/from that peer reuses this shared key.
  const peerKeys = new Map<string, Uint8Array>()
  for (const peer of config.peers) {
    peerKeys.set(peer.deviceId, deriveSharedKey(fromB64(peer.pubKey), fromB64(config.secretKey)))
  }

  // peer deviceId -> (request id -> in-flight state). Keyed per peer so a
  // presence {online:false} can kill exactly that peer's streams.
  const inflight = new Map<string, Map<string, Inflight>>()

  // ws(s):// mirroring the relay URL's http(s) scheme, path per the protocol.
  const wsUrl = (() => {
    const u = new URL(config.url)
    u.protocol = u.protocol === "http:" ? "ws:" : "wss:"
    u.pathname = u.pathname.replace(/\/+$/, "") + RELAY_WS_PATH
    return u.toString()
  })()

  let ws: WebSocket | null = null
  let stopped = false
  let backoffMs = 1_000
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  // Highest seq seen THIS BOOT. The first hello of a boot omits lastSeq (deep
  // history replays from the server's sqlite, not the relay buffer); reconnect
  // hellos pass it so the relay resumes where we left off instead of replaying.
  let lastSeq: number | undefined

  function sendRaw(frame: RelayClientFrame): void {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame))
  }

  /** Seal + send one tunnel frame to a peer. Frames are silently dropped while
   *  the socket is down — the phone recovers by reopening its SSE tunnel (the
   *  transcript lives in sqlite), so best-effort delivery is enough here. */
  function sendTo(peerId: string, frame: TunnelFrame): void {
    const key = peerKeys.get(peerId)
    if (!key) return
    sendRaw({ t: "send", to: peerId, payload: sealJSON(frame, key) })
  }

  function abortRequest(peerId: string, id: string): void {
    const entry = inflight.get(peerId)?.get(id)
    if (!entry) return
    inflight.get(peerId)?.delete(id)
    entry.ac.abort()
    void entry.reader?.cancel().catch(() => {})
  }

  /** Kill every in-flight request/stream for a peer (offline or stop()). */
  function abortPeer(peerId: string): void {
    const ids = [...(inflight.get(peerId)?.keys() ?? [])]
    for (const id of ids) abortRequest(peerId, id)
  }

  /** Re-issue a tunneled request against the local server. SSE responses are
   *  pumped as start/chunk/end frames; everything else is buffered whole. */
  async function handleRequest(peerId: string, frame: Extract<TunnelFrame, { t: "http.req" }>): Promise<void> {
    const ac = new AbortController()
    let byId = inflight.get(peerId)
    if (!byId) inflight.set(peerId, (byId = new Map()))
    const entry: Inflight = { ac }
    byId.set(frame.id, entry)
    let streaming = false
    try {
      const res = await fetch(localBaseUrl + frame.path, {
        method: frame.method,
        headers: { ...frame.headers, Authorization: `Bearer ${getServerToken()}` },
        // fromB64 types as Uint8Array<ArrayBufferLike>, but it is always backed
        // by a plain ArrayBuffer at runtime — which is what BodyInit requires.
        body: frame.body ? (fromB64(frame.body) as Uint8Array<ArrayBuffer>) : undefined,
        signal: ac.signal,
      })
      // Forward the response headers as-is (content-type included) so the
      // phone-side client can dispatch on them like a normal HTTP response.
      const headers = Object.fromEntries(res.headers.entries())
      if ((res.headers.get("content-type") ?? "").includes("text/event-stream") && res.body) {
        sendTo(peerId, { t: "http.res.start", id: frame.id, status: res.status, headers })
        streaming = true
        const reader = res.body.getReader()
        entry.reader = reader
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          sendTo(peerId, { t: "http.res.chunk", id: frame.id, data: toB64(value) })
        }
        sendTo(peerId, { t: "http.res.end", id: frame.id })
      } else {
        const body = new Uint8Array(await res.arrayBuffer())
        sendTo(peerId, {
          t: "http.res",
          id: frame.id,
          status: res.status,
          headers,
          ...(body.length ? { body: toB64(body) } : {}),
        })
      }
    } catch (err) {
      // Aborted means the peer cancelled or went offline — replying would only
      // fill its relay outbox with frames nobody will read.
      if (!ac.signal.aborted) {
        const message = (err as Error)?.message ?? String(err)
        log(`local ${frame.method} ${frame.path} failed: ${message}`)
        if (streaming) {
          // The start frame is already out; end the stream instead of sending
          // a second (protocol-invalid) http.res for the same id.
          sendTo(peerId, { t: "http.res.end", id: frame.id })
        } else {
          sendTo(peerId, {
            t: "http.res",
            id: frame.id,
            status: 502,
            headers: { "content-type": "text/plain" },
            body: toB64(new TextEncoder().encode(message)),
          })
        }
      }
    } finally {
      inflight.get(peerId)?.delete(frame.id)
    }
  }

  function handleTunnelFrame(peerId: string, frame: TunnelFrame): void {
    switch (frame.t) {
      case "http.req":
        void handleRequest(peerId, frame)
        break
      case "http.cancel":
        abortRequest(peerId, frame.id)
        break
      default:
        // http.res* frames only flow computer -> phone; ignore anything else.
        break
    }
  }

  function handleFrame(frame: RelayServerFrame): void {
    switch (frame.t) {
      case "hello.ok": {
        backoffMs = 1_000 // healthy connection — reset the reconnect backoff
        const online = frame.peers.filter((p) => p.online).length
        log(`connected as ${frame.deviceId} (${online}/${frame.peers.length} peers online)`)
        break
      }
      case "recv": {
        if (frame.seq > (lastSeq ?? 0)) lastSeq = frame.seq
        const key = peerKeys.get(frame.from)
        if (!key) {
          log(`dropped frame from unknown peer ${frame.from}`)
        } else {
          try {
            handleTunnelFrame(frame.from, openJSON<TunnelFrame>(frame.payload, key))
          } catch {
            log(`dropped frame from ${frame.from}: failed authentication`)
          }
        }
        // Ack after processing so the relay only prunes frames we dispatched.
        sendRaw({ t: "ack", seq: frame.seq })
        break
      }
      case "presence":
        log(`peer ${frame.deviceId} ${frame.online ? "online" : "offline"}`)
        // An offline peer can't read anything we stream — kill its in-flight
        // requests so dead SSE chunks never pile up in its relay outbox.
        if (!frame.online) abortPeer(frame.deviceId)
        break
      case "error":
        log(`relay error (${frame.code}): ${frame.message}`)
        break
      case "pong":
        break
    }
  }

  function connect(): void {
    if (stopped) return
    const sock = new WebSocket(wsUrl)
    ws = sock
    sock.onopen = () => {
      sock.send(
        JSON.stringify({
          t: "hello",
          token: config.deviceToken,
          ...(lastSeq !== undefined ? { lastSeq } : {}),
        } satisfies RelayClientFrame),
      )
    }
    sock.onmessage = (ev) => {
      try {
        handleFrame(JSON.parse(String(ev.data)) as RelayServerFrame)
      } catch {
        log("dropped malformed relay frame")
      }
    }
    sock.onclose = () => {
      if (ws !== sock) return // superseded by a newer socket
      ws = null
      if (stopped) return
      log(`disconnected — reconnecting in ${Math.round(backoffMs / 1000)}s`)
      reconnectTimer = setTimeout(connect, backoffMs)
      backoffMs = Math.min(backoffMs * 2, 30_000)
    }
    sock.onerror = () => {
      // onclose always follows an error; reconnection is scheduled there.
    }
  }

  // App-level keepalive: NAT/proxies silently drop idle connections, and a
  // half-dead socket would make this computer look online while unreachable.
  // A tiny ping keeps the tunnel warm; pong is ignored above.
  const pingTimer = setInterval(() => sendRaw({ t: "ping" }), 25_000)

  log(`uplink -> ${config.url} (${config.peers.length} peer${config.peers.length === 1 ? "" : "s"})`)
  connect()

  return {
    stop() {
      stopped = true
      clearInterval(pingTimer)
      if (reconnectTimer) clearTimeout(reconnectTimer)
      for (const peerId of [...inflight.keys()]) abortPeer(peerId)
      ws?.close()
      ws = null
    },
  }
}
