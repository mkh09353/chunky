// `bun run pair` — one-time pairing of this computer with a phone.
// The pairing mechanics live in pairing.ts so the authenticated local desktop
// API and CLI follow precisely the same canonical crypto/configuration flow.
import qrcode from "qrcode-terminal"
import { RelayPairing } from "./pairing.ts"
import { loadRelayConfig } from "./config.ts"

const existing = loadRelayConfig()
if (existing && !process.argv.includes("--force")) {
  console.log(`Already paired as deviceId ${existing.deviceId} (relay ${existing.url}). Peers:`)
  for (const peer of existing.peers) console.log(`  - ${peer.name} (${peer.deviceId})`)
  console.log("Re-run with --force to discard this pairing and start over.")
  process.exit(1)
}
const pairing = new RelayPairing()
let started
try {
  // The historical CLI --force behavior remains CLI-only; the desktop API
  // always refuses to replace an existing pairing.
  started = await pairing.begin(undefined, process.argv.includes("--force"))
} catch (err) {
  console.error((err as Error).message)
  process.exit(1)
}
console.log(`\nScan with the Chunky app to pair a phone with "${started.name}" via ${started.relayUrl}:\n`)
qrcode.generate(started.qrPayload, { small: true })
console.log(`\nOr enter this code manually:\n\n  ${started.qrPayload}\n`)
const spinner = ["|", "/", "-", "\\"]
let tick = 0
while (true) {
  process.stdout.write(`\r${spinner[tick++ % spinner.length]} waiting for a phone to scan…  `)
  await Bun.sleep(2000)
  const { result } = await pairing.poll()
  if (result.status === "claimed") {
    console.log(`\n\nPaired with ${result.peer.name} (${result.peer.deviceId}).`)
    console.log("Wrote relay.json — restart the server to go live.")
    process.exit(0)
  }
  if (result.status === "expired") {
    console.error("\n\nPairing code expired before a phone claimed it. Run `bun run pair` again.")
    process.exit(1)
  }
}
