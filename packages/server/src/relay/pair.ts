// `bun run pair` — one-time pairing of this computer with a phone.
//
// Registers this computer on the relay (POST /pair/begin), then renders a QR
// carrying the relay URL, the pairing code, this computer's X25519 public key
// and a one-time secret. The QR is the trusted channel: the phone answers with
// its own public key sealed under that secret, so the relay — which never sees
// the secret — can neither read nor substitute keys (internal relay design doc).
// On claim we write relay.json; index.ts boots the uplink from it on the next
// server start.
import { hostname } from "node:os"
import qrcode from "qrcode-terminal"
import {
  DEFAULT_RELAY_URL,
  RELAY_ROUTES,
  type PairBeginResponse,
  type PairStatusResponse,
} from "@chunky/protocol/relay"
import {
  encodePairingQR,
  generateDeviceKeyPair,
  newPairingSecret,
  openPairingClaim,
  toB64,
} from "@chunky/protocol/relay-crypto"
import { loadRelayConfig, saveRelayConfig } from "./config.ts"

const relayUrl = (process.env.CHUNKY_RELAY_URL || DEFAULT_RELAY_URL).replace(/\/+$/, "")

// Refuse to silently clobber an existing pairing: overwriting relay.json
// discards this computer's keypair, which unpairs every phone at once.
const existing = loadRelayConfig()
if (existing && !process.argv.includes("--force")) {
  console.log(`Already paired as deviceId ${existing.deviceId} (relay ${existing.url}). Peers:`)
  for (const peer of existing.peers) console.log(`  - ${peer.name} (${peer.deviceId})`)
  console.log("Re-run with --force to discard this pairing and start over.")
  process.exit(1)
}

const name = hostname()
let beginRes: Response
try {
  beginRes = await fetch(relayUrl + RELAY_ROUTES.pairBegin, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "computer", name }),
  })
} catch (err) {
  console.error(`Could not reach the relay at ${relayUrl}: ${(err as Error)?.message ?? err}`)
  process.exit(1)
}
if (!beginRes.ok) {
  console.error(`pair/begin failed: ${beginRes.status} ${await beginRes.text().catch(() => "")}`)
  process.exit(1)
}
const begin = (await beginRes.json()) as PairBeginResponse

// The keypair is generated HERE and only its public half ever leaves the
// machine; the pairing secret rides the QR and is never sent to the relay.
const keys = generateDeviceKeyPair()
const secret = newPairingSecret()
const qrPayload = encodePairingQR({
  v: 1,
  relay: relayUrl,
  code: begin.code,
  computerPubKey: toB64(keys.publicKey),
  secret: toB64(secret),
  name,
})

console.log(`\nScan with the Chunky app to pair a phone with "${name}" via ${relayUrl}:\n`)
qrcode.generate(qrPayload, { small: true })
console.log(`\nOr enter this code manually:\n\n  ${qrPayload}\n`)

// Poll until a phone claims the code (or it expires). openPairingClaim
// authenticates that the claim really came from whoever scanned the QR.
const SPINNER = ["|", "/", "-", "\\"]
let tick = 0
while (true) {
  process.stdout.write(`\r${SPINNER[tick++ % SPINNER.length]} waiting for a phone to scan…  `)
  await new Promise((resolve) => setTimeout(resolve, 2000))

  let status: PairStatusResponse | undefined
  try {
    const res = await fetch(relayUrl + RELAY_ROUTES.pairStatus(begin.code), {
      headers: { authorization: `Bearer ${begin.deviceToken}` },
    })
    if (res.ok) status = (await res.json()) as PairStatusResponse
  } catch {
    // transient relay hiccup — keep polling; local expiry check below backstops
  }

  if (status?.status === "claimed") {
    const claim = openPairingClaim(status.claim, secret)
    saveRelayConfig({
      url: relayUrl,
      deviceId: begin.deviceId,
      deviceToken: begin.deviceToken,
      publicKey: toB64(keys.publicKey),
      secretKey: toB64(keys.secretKey),
      peers: [
        {
          deviceId: status.phone.deviceId,
          name: claim.name ?? status.phone.name,
          pubKey: claim.phonePubKey,
        },
      ],
    })
    console.log(`\n\nPaired with ${claim.name ?? status.phone.name} (${status.phone.deviceId}).`)
    console.log("Wrote relay.json — restart the server to go live.")
    process.exit(0)
  }
  if (status?.status === "expired" || Date.now() > begin.expiresAt + 60_000) {
    console.error("\n\nPairing code expired before a phone claimed it. Run `bun run pair` again.")
    process.exit(1)
  }
}
