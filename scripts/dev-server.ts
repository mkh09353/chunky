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
// installed app ignores in favour of a free port). Override with CHUNKY_DEV_PORT.
// Deliberately NOT CHUNKY_PORT: the installed launcher (chunky.ts) exports its
// own ephemeral CHUNKY_PORT into every shell it spawns, so a `bun run server`
// started from inside a Chunky session would silently bind the wrong port.
const DEV_PORT = 4620
const port = Number(process.env.CHUNKY_DEV_PORT) || DEV_PORT

// Scrub launcher-session env. When this script runs from a shell spawned by an
// installed Chunky session, the launcher's per-server env leaks in and corrupts
// dev: CHUNKY_SERVER_NONCE makes the server think it's launcher-managed (the
// lease loop then SIGTERMs it ~30s in with no clients — "Polite quit request"),
// CHUNKY_DISCOVERY_RECORD/CHUNKY_SERVER_ID fight over the installed server's
// registration, and CHUNKY_DB/CHUNKY_GRAPH_DB point at the installed state.
for (const key of [
  "CHUNKY_SERVER_NONCE",
  "CHUNKY_SERVER_ID",
  "CHUNKY_DISCOVERY_RECORD",
  "CHUNKY_BUILD_ID",
  "CHUNKY_VERSION",
  "CHUNKY_DB",
  "CHUNKY_GRAPH_DB",
  "CHUNKY_WORKSPACE",
]) {
  delete process.env[key]
}
// Settings stay on the user's real file (NOT scrubbed to the repo-local
// settings.json): the app's bun process reads serverToken from
// ~/.chunky/state/settings.json by default, and dev must agree on the token
// or every request 401s. Override with CHUNKY_DEV_SETTINGS.
process.env.CHUNKY_SETTINGS =
  process.env.CHUNKY_DEV_SETTINGS ||
  `${process.env.HOME}/.chunky/state/settings.json`
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
