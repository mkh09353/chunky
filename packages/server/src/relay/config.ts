// Relay uplink configuration — written by `bun run pair`, read at server boot.
//
// One JSON file (CHUNKY_RELAY_CONFIG || "relay.json", relative to the server
// cwd = repo root, same convention as settings.ts). It holds this computer's
// relay identity (deviceId + deviceToken), its X25519 keypair, and each paired
// peer's public key — everything needed to reconnect without re-pairing. The
// file is gitignored and written mode 600 because the secretKey is what keeps
// relay traffic end-to-end encrypted (and the deviceToken is what lets us
// connect as this device). Missing/corrupt file → null, matching settings.ts's
// defensive style (a bad relay.json must never take the server down).
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs"

/** A paired remote device (phone). Its pubKey came through the pairing QR
 *  flow, never through the relay — see docs/relay-design.md. */
export interface RelayPeer {
  deviceId: string
  name: string
  /** b64 — the peer's X25519 public key. */
  pubKey: string
}

export interface RelayConfig {
  /** Relay base URL, e.g. https://relay.chunky.to */
  url: string
  /** This computer's device id on the relay. */
  deviceId: string
  /** This computer's relay credential (WS hello). */
  deviceToken: string
  /** b64 — this computer's X25519 keypair. */
  publicKey: string
  secretKey: string
  /** Devices allowed to tunnel to this server. */
  peers: RelayPeer[]
}

function configPath(): string {
  return process.env.CHUNKY_RELAY_CONFIG || "relay.json"
}

/** The persisted relay config, or null when unpaired (missing file) or the
 *  file is unreadable/corrupt — callers treat null as "relay disabled". */
export function loadRelayConfig(): RelayConfig | null {
  const p = configPath()
  if (!existsSync(p)) return null
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as RelayConfig
    if (!parsed || typeof parsed !== "object") return null
    if (!parsed.url || !parsed.deviceId || !parsed.deviceToken) return null
    if (!parsed.publicKey || !parsed.secretKey || !Array.isArray(parsed.peers)) return null
    return parsed
  } catch {
    return null
  }
}

export function saveRelayConfig(cfg: RelayConfig): void {
  const p = configPath()
  writeFileSync(p, JSON.stringify(cfg, null, 2))
  // Owner-only: the file holds the E2E secret key and the device token.
  chmodSync(p, 0o600)
}
