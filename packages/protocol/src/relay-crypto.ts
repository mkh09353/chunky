// @chunky/protocol/relay-crypto — pairing + end-to-end encryption for relay
// traffic. tweetnacl only (X25519 ECDH + XSalsa20-Poly1305), portable to the
// browser and to Swift (CryptoKit / libsodium) later.
//
// Trust model (see the internal relay design doc): the pairing QR is the trusted
// channel. It carries the computer's public key and a one-time 32-byte secret;
// the phone returns its own public key sealed with that secret, so the relay
// can neither read nor substitute keys. After pairing, both sides derive the
// same shared key via ECDH and every frame is an authenticated secretbox with
// a fresh random 24-byte nonce, encoded b64(nonce ‖ ciphertext).
import nacl from "tweetnacl"

export interface DeviceKeyPair {
  publicKey: Uint8Array
  secretKey: Uint8Array
}

export function generateDeviceKeyPair(): DeviceKeyPair {
  return nacl.box.keyPair()
}

export function newPairingSecret(): Uint8Array {
  return nacl.randomBytes(nacl.secretbox.keyLength)
}

// ---- base64 helpers (btoa/atob: work in Bun, browsers, and JavaScriptCore) ----

export function toB64(bytes: Uint8Array): string {
  let bin = ""
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

export function fromB64(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

// ---- Pairing QR payload ----

export const PAIRING_QR_PREFIX = "chunky1:"

/** Everything the phone needs to pair, rendered as a QR on the computer. */
export interface PairingQR {
  v: 1
  /** Relay base URL, e.g. https://relay.chunky.to */
  relay: string
  /** Pairing code from POST /pair/begin. */
  code: string
  /** b64 — the computer's X25519 public key (trusted: comes via the QR). */
  computerPubKey: string
  /** b64 — one-time 32-byte pairing secret (never sent to the relay). */
  secret: string
  /** Computer display name. */
  name?: string
}

export function encodePairingQR(qr: PairingQR): string {
  const json = JSON.stringify(qr)
  const b64url = btoa(json).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
  return PAIRING_QR_PREFIX + b64url
}

export function decodePairingQR(s: string): PairingQR {
  if (!s.startsWith(PAIRING_QR_PREFIX)) throw new Error("relay-crypto: not a chunky pairing code")
  const b64 = s.slice(PAIRING_QR_PREFIX.length).replace(/-/g, "+").replace(/_/g, "/")
  const pad = b64.length % 4 === 0 ? b64 : b64 + "=".repeat(4 - (b64.length % 4))
  const qr = JSON.parse(atob(pad)) as PairingQR
  if (qr.v !== 1 || !qr.relay || !qr.code || !qr.computerPubKey || !qr.secret) {
    throw new Error("relay-crypto: malformed pairing payload")
  }
  return qr
}

// ---- Pairing claim (phone -> computer, via the relay, sealed with the QR secret) ----

export interface PairingClaim {
  /** b64 — the phone's X25519 public key. */
  phonePubKey: string
  name?: string
}

export function sealPairingClaim(claim: PairingClaim, secret: Uint8Array): string {
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength)
  const msg = new TextEncoder().encode(JSON.stringify(claim))
  const ct = nacl.secretbox(msg, nonce, secret)
  const out = new Uint8Array(nonce.length + ct.length)
  out.set(nonce)
  out.set(ct, nonce.length)
  return toB64(out)
}

export function openPairingClaim(blob: string, secret: Uint8Array): PairingClaim {
  const bytes = fromB64(blob)
  const nonce = bytes.slice(0, nacl.secretbox.nonceLength)
  const ct = bytes.slice(nacl.secretbox.nonceLength)
  const msg = nacl.secretbox.open(ct, nonce, secret)
  if (!msg) throw new Error("relay-crypto: pairing claim failed authentication")
  return JSON.parse(new TextDecoder().decode(msg)) as PairingClaim
}

// ---- Message layer: ECDH once, then authenticated encryption per frame ----

/** X25519 ECDH -> the 32-byte key both sides share. Compute once per peer. */
export function deriveSharedKey(peerPublicKey: Uint8Array, mySecretKey: Uint8Array): Uint8Array {
  return nacl.box.before(peerPublicKey, mySecretKey)
}

/** Encrypt any JSON value for the peer -> b64(nonce ‖ ciphertext). */
export function sealJSON(value: unknown, sharedKey: Uint8Array): string {
  const nonce = nacl.randomBytes(nacl.box.nonceLength)
  const msg = new TextEncoder().encode(JSON.stringify(value))
  const ct = nacl.box.after(msg, nonce, sharedKey)
  const out = new Uint8Array(nonce.length + ct.length)
  out.set(nonce)
  out.set(ct, nonce.length)
  return toB64(out)
}

/** Decrypt + authenticate a sealJSON blob. Throws on tampering/wrong key. */
export function openJSON<T = unknown>(blob: string, sharedKey: Uint8Array): T {
  const bytes = fromB64(blob)
  const nonce = bytes.slice(0, nacl.box.nonceLength)
  const ct = bytes.slice(nacl.box.nonceLength)
  const msg = nacl.box.open.after(ct, nonce, sharedKey)
  if (!msg) throw new Error("relay-crypto: frame failed authentication")
  return JSON.parse(new TextDecoder().decode(msg)) as T
}
