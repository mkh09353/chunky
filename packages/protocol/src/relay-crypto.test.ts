// Deterministic tests for the relay pairing + E2E crypto (relay-crypto.ts):
// the base64 helpers, QR encode/decode, sealed pairing claims, ECDH key
// agreement, and the per-frame secretbox layer. Pure functions — no relay,
// no network.
import { describe, expect, test } from "bun:test"
import {
  PAIRING_QR_PREFIX,
  decodePairingQR,
  deriveSharedKey,
  encodePairingQR,
  fromB64,
  generateDeviceKeyPair,
  newPairingSecret,
  openJSON,
  openPairingClaim,
  sealJSON,
  sealPairingClaim,
  toB64,
} from "./relay-crypto.ts"
import type { PairingQR } from "./relay-crypto.ts"

describe("toB64/fromB64", () => {
  test("round-trips every byte value", () => {
    const all = new Uint8Array(256)
    for (let i = 0; i < 256; i++) all[i] = i // includes 0 and 255
    expect(fromB64(toB64(all))).toEqual(all)
  })

  test("round-trips random buffers of awkward lengths", () => {
    for (const len of [0, 1, 2, 3, 31, 32, 33, 1024]) {
      const bytes = crypto.getRandomValues(new Uint8Array(len))
      if (len >= 2) {
        bytes[0] = 0 // force the edge values in no matter what randomness said
        bytes[len - 1] = 255
      }
      expect(fromB64(toB64(bytes))).toEqual(bytes)
    }
  })
})

describe("pairing QR", () => {
  const qr: PairingQR = {
    v: 1,
    relay: "https://relay.chunky.to",
    code: "AB3D5F",
    computerPubKey: toB64(generateDeviceKeyPair().publicKey),
    secret: toB64(newPairingSecret()),
    name: "Max's MacBook",
  }

  test("encode/decode round trip", () => {
    const encoded = encodePairingQR(qr)
    expect(encoded.startsWith(PAIRING_QR_PREFIX)).toBe(true)
    expect(decodePairingQR(encoded)).toEqual(qr)
  })

  test("round trip without the optional name", () => {
    const { name: _name, ...anon } = qr
    expect(decodePairingQR(encodePairingQR(anon as PairingQR))).toEqual(anon as PairingQR)
  })

  test("rejects a malformed prefix", () => {
    const payload = encodePairingQR(qr).slice(PAIRING_QR_PREFIX.length)
    expect(() => decodePairingQR(`otherapp1:${payload}`)).toThrow("not a chunky pairing code")
    expect(() => decodePairingQR(payload)).toThrow("not a chunky pairing code")
    expect(() => decodePairingQR("")).toThrow("not a chunky pairing code")
  })

  test("rejects a payload with missing fields", () => {
    expect(() => decodePairingQR(PAIRING_QR_PREFIX + btoa(JSON.stringify({ v: 1 })))).toThrow(
      "malformed pairing payload",
    )
  })
})

describe("pairing claim", () => {
  test("seal/open round trip", () => {
    const secret = newPairingSecret()
    const claim = { phonePubKey: toB64(generateDeviceKeyPair().publicKey), name: "Max's iPhone" }
    expect(openPairingClaim(sealPairingClaim(claim, secret), secret)).toEqual(claim)
  })

  test("rejects the wrong secret", () => {
    const claim = { phonePubKey: toB64(generateDeviceKeyPair().publicKey) }
    const blob = sealPairingClaim(claim, newPairingSecret())
    expect(() => openPairingClaim(blob, newPairingSecret())).toThrow("failed authentication")
  })
})

describe("deriveSharedKey", () => {
  test("computer and phone derive the same key", () => {
    const computer = generateDeviceKeyPair()
    const phone = generateDeviceKeyPair()
    const computerSide = deriveSharedKey(phone.publicKey, computer.secretKey)
    const phoneSide = deriveSharedKey(computer.publicKey, phone.secretKey)
    expect(computerSide).toEqual(phoneSide)
    expect(computerSide.length).toBe(32)
  })
})

describe("sealJSON/openJSON", () => {
  const computer = generateDeviceKeyPair()
  const phone = generateDeviceKeyPair()
  const key = deriveSharedKey(phone.publicKey, computer.secretKey)

  test("round-trips JSON values", () => {
    const frame = { t: "http.req", id: "abc", method: "GET", path: "/api/sessions", headers: { "x-nested": "yes" } }
    const blob = sealJSON(frame, key)
    expect(openJSON<typeof frame>(blob, key)).toEqual(frame)
    // fresh random nonce per frame: sealing the same value twice never
    // produces the same blob
    expect(sealJSON(frame, key)).not.toBe(blob)
  })

  test("the peer's derived key opens what we seal", () => {
    const phoneSideKey = deriveSharedKey(computer.publicKey, phone.secretKey)
    expect(openJSON<{ hello: string }>(sealJSON({ hello: "phone" }, key), phoneSideKey)).toEqual({ hello: "phone" })
  })

  test("rejects a tampered frame", () => {
    const blob = sealJSON({ hello: "world" }, key)
    const bytes = fromB64(blob)
    bytes[bytes.length - 1] ^= 0x01 // flip one ciphertext bit
    expect(() => openJSON(toB64(bytes), key)).toThrow("failed authentication")
  })

  test("rejects the wrong key", () => {
    const blob = sealJSON({ hello: "world" }, key)
    const stranger = generateDeviceKeyPair()
    const wrongKey = deriveSharedKey(phone.publicKey, stranger.secretKey)
    expect(() => openJSON(blob, wrongKey)).toThrow("failed authentication")
  })
})
