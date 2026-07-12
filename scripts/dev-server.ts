#!/usr/bin/env bun
// Dev server launcher. Pins the dev stack to its OWN port (4620) — never the
// installed app's port. The installed `chunky` launcher self-assigns a free port
// (chunky.ts), so dev and an installed copy never collide; this keeps dev on a
// single, predictable port distinct from DEFAULT_PORT (4599).
//
// It also FREES the port before starting: the recurring trap was a leftover dev
// server holding the port, so a new `bun run server` crashed on EADDRINUSE while
// the stale one kept answering the TUI/GUI — you'd unknowingly drive old code.
// Killing any prior listener first means the newest `bun run server` always wins.
import { DEFAULT_PORT } from "@chunky/protocol"

// Dev's dedicated port. Distinct from DEFAULT_PORT (4599, the wire default the
// installed app ignores in favour of a free port). Override with CHUNKY_PORT.
const DEV_PORT = 4620
const port = Number(process.env.CHUNKY_PORT) || DEV_PORT
// Make the server (imported below) and every child read the same port.
process.env.CHUNKY_PORT = String(port)

/** Kill any process LISTENing on `p` (best-effort; macOS/Linux via lsof). */
function freePort(p: number): void {
  let out = ""
  try {
    const res = Bun.spawnSync(["lsof", "-ti", `tcp:${p}`, "-sTCP:LISTEN"])
    out = new TextDecoder().decode(res.stdout)
  } catch {
    return // no lsof (unlikely on macOS/Linux) — let Bun.serve surface EADDRINUSE
  }
  for (const line of out.split("\n")) {
    const pid = Number(line.trim())
    if (!pid || pid === process.pid) continue
    try {
      process.kill(pid, "SIGTERM")
      console.log(`[dev] freed port ${p} — terminated stale server (pid ${pid})`)
    } catch {
      // already gone / not ours — ignore
    }
  }
}

freePort(port)
// Give the OS a beat to release the socket before the server binds it.
await new Promise((r) => setTimeout(r, 250))

console.log(`[dev] starting server on http://localhost:${port} (dev port; DEFAULT_PORT=${DEFAULT_PORT})`)
await import("../packages/server/src/index.ts")
