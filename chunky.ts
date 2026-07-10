#!/usr/bin/env bun
// Chunky launcher. Boots the server + TUI as two child processes so an installed
// copy runs standalone, independent of the dev tree:
//   - a FREE port is chosen (never clashes with a running dev server),
//   - the agent's workspace is the directory you ran `chunky` from (edits YOUR code),
//   - db/auth/settings live in ~/.chunky/state (never littered into your project),
//   - the server's stdout goes to a log file so it can't fight the TUI's rendering.
// The app code is resolved relative to THIS file, so the same launcher works both
// from the repo (dev) and from an installed ~/.chunky/app copy.
import { spawn } from "node:child_process"
import { createServer } from "node:net"
import { existsSync, mkdirSync, openSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const APP = dirname(fileURLToPath(import.meta.url))
const STATE = process.env.CHUNKY_HOME || join(homedir(), ".chunky", "state")
const WORKSPACE = process.cwd()
mkdirSync(STATE, { recursive: true })

/** Parse a minimal KEY=VALUE .env (quotes stripped, `#` comments ignored). */
function loadEnv(path: string): Record<string, string> {
  const out: Record<string, string> = {}
  if (!existsSync(path)) return out
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (!m || line.trimStart().startsWith("#")) continue
    let v = m[2]!
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    out[m[1]!] = v
  }
  return out
}

/** An OS-assigned free TCP port, so we never collide with a dev server. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.on("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port
      srv.close(() => resolve(port))
    })
  })
}

const PORT = process.env.CHUNKY_PORT ? Number(process.env.CHUNKY_PORT) : await freePort()
const base = `http://localhost:${PORT}`

// Start the server (child #1). State paths are pinned to ~/.chunky/state; the
// agent's WORKSPACE is your invocation dir; ZEN/etc. keys come from state/.env.
const log = openSync(join(STATE, "server.log"), "a")
const server = spawn("bun", ["run", join(APP, "packages/server/src/index.ts")], {
  cwd: STATE,
  stdio: ["ignore", log, log],
  env: {
    ...process.env,
    ...loadEnv(join(STATE, ".env")),
    CHUNKY_PORT: String(PORT),
    CHUNKY_WORKSPACE: WORKSPACE,
    CHUNKY_DB: join(STATE, "chunky.db"),
    CHUNKY_GRAPH_DB: join(STATE, "chunky-graph.db"),
    CHUNKY_SETTINGS: join(STATE, "settings.json"),
    CHUNKY_AUTH: join(STATE, "auth.json"),
  },
})

// Wait (up to ~15s) for the server to accept connections.
async function up(): Promise<boolean> {
  try {
    return (await fetch(base + "/", { signal: AbortSignal.timeout(400) })).status < 500
  } catch {
    return false
  }
}
const deadline = Date.now() + 15_000
while (Date.now() < deadline && !(await up())) await new Promise((r) => setTimeout(r, 200))

// Hand the terminal to the TUI (child #2), pointed at our server. cwd is your
// project so the transcript shows the right path; it connects over CHUNKY_PORT.
const tui = spawn("bun", ["run", join(APP, "packages/tui/src/index.tsx"), "--live"], {
  cwd: WORKSPACE,
  stdio: "inherit",
  env: { ...process.env, CHUNKY_PORT: String(PORT) },
})

const shutdown = () => {
  try { server.kill("SIGTERM") } catch {}
}
tui.on("exit", (code) => {
  shutdown()
  process.exit(code ?? 0)
})
process.on("SIGINT", () => tui.kill("SIGINT"))
process.on("SIGTERM", () => {
  tui.kill("SIGTERM")
  shutdown()
})
