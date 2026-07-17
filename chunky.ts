#!/usr/bin/env bun
// Chunky launcher. Discovers (or boots) a workspace server, then starts the TUI:
//   - launchers for the same canonical workspace + Chunky version share a server,
//   - the agent's workspace is the directory you ran `chunky` from (edits YOUR code),
//   - db/auth/settings live in ~/.chunky/state (never littered into your project),
//   - the server's stdout goes to a log file so it can't fight the TUI's rendering.
// The app code is resolved relative to THIS file, so the same launcher works both
// from the repo (dev) and from an installed ~/.chunky/app copy.
import { spawn } from "node:child_process"
import { createServer } from "node:net"
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import { checkForUpdate, rollback, update } from "./packages/server/src/update/updater.ts"
import {
  canonicalWorkspace,
  computeAppBuildId,
  ensureWorkspaceServer,
  serverIdentityKey,
  updateServerLease,
  type LauncherServerIdentity,
} from "./packages/server/src/launcher-discovery.ts"

const APP = dirname(fileURLToPath(import.meta.url))
const PACKAGE = JSON.parse(readFileSync(join(APP, "package.json"), "utf8")) as { version: string }

if (process.argv[2] === "--version" || process.argv[2] === "-v") {
  console.log(`chunky v${PACKAGE.version}`)
  process.exit(0)
}
if (process.argv[2] === "update") {
  try {
    if (process.argv.includes("--rollback")) { rollback(); console.log("Rolled back Chunky. Restart chunky to finish updating.") }
    else if (process.argv.includes("--check")) {
      const result = await checkForUpdate()
      console.log(result.latest ? `Current: v${result.current}; latest: v${result.latest}${result.available ? " (update available)" : " (up to date)"}` : `Current: v${result.current}; latest unavailable`)
    } else {
      const flag = process.argv.indexOf("--version")
      const release = await update(flag >= 0 ? process.argv[flag + 1] : undefined)
      console.log(`Updated to v${release.version}. Restart chunky to finish updating.`)
    }
  } catch (err) { console.error(`Update failed: ${(err as Error).message}`); process.exitCode = 1 }
  process.exit()
}

const STATE = process.env.CHUNKY_HOME || join(homedir(), ".chunky", "state")
const WORKSPACE = canonicalWorkspace(process.cwd())
const BUILD_ID = computeAppBuildId(APP)
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

// Provider keys from state/.env (ZEN_*, etc.), but strip any CHUNKY_* — the
// launcher owns the port, workspace, and every state path, so a stale dev .env
// can't pin the port and re-introduce the clash.
const dotenv = loadEnv(join(STATE, ".env"))
for (const k of Object.keys(dotenv)) if (k.startsWith("CHUNKY_")) delete dotenv[k]

async function startServer(identity: LauncherServerIdentity): Promise<{ pid: number; stop(): void }> {
  // The server is detached from this launcher: closing the TUI that happened to
  // create it must not disconnect TUIs that subsequently reused it.
  const log = openSync(join(STATE, "server.log"), "a")
  try {
    const child = spawn("bun", ["run", join(APP, "packages/server/src/index.ts")], {
      cwd: STATE,
      detached: true,
      stdio: ["ignore", log, log],
      env: {
        ...process.env,
        ...dotenv,
        CHUNKY_PORT: String(identity.port),
        CHUNKY_WORKSPACE: identity.workspace,
        CHUNKY_VERSION: identity.version,
        CHUNKY_BUILD_ID: identity.buildId,
        CHUNKY_SERVER_NONCE: identity.nonce,
        CHUNKY_SERVER_ID: identity.id,
        CHUNKY_DISCOVERY_RECORD: join(STATE, "servers", `${serverIdentityKey(identity.workspace, identity.version, identity.buildId)}.json`),
        CHUNKY_DB: join(STATE, "chunky.db"),
        CHUNKY_GRAPH_DB: join(STATE, "chunky-graph.db"),
        CHUNKY_SETTINGS: join(STATE, "settings.json"),
        CHUNKY_AUTH: join(STATE, "auth.json"),
      },
    })
    if (!child.pid) throw new Error("failed to start Chunky server")
    child.unref()
    return { pid: child.pid, stop: () => { child.kill("SIGTERM") } }
  } finally {
    closeSync(log)
  }
}

const shared = await ensureWorkspaceServer({
  stateDir: STATE,
  workspace: WORKSPACE,
  version: PACKAGE.version,
  buildId: BUILD_ID,
}, {
  allocatePort: async () => process.env.CHUNKY_FORCE_PORT
    ? Number(process.env.CHUNKY_FORCE_PORT)
    : freePort(),
  startServer,
  stopPid: (pid) => { try { process.kill(pid, "SIGTERM") } catch {} },
})
const PORT = shared.record.port
const leaseToken = randomUUID()
await updateServerLease(PORT, leaseToken, "attach")
const leaseHeartbeat = setInterval(() => {
  void updateServerLease(PORT, leaseToken, "attach").catch(() => {})
}, 10_000)
leaseHeartbeat.unref()

// Hand the terminal to the TUI (child #2), pointed at our server. cwd is your
// project so the transcript shows the right path; it connects over CHUNKY_PORT.
const tui = spawn("bun", ["run", join(APP, "packages/tui/src/index.tsx"), "--live"], {
  cwd: WORKSPACE,
  stdio: "inherit",
  env: { ...process.env, CHUNKY_PORT: String(PORT) },
})

tui.on("exit", async (code) => {
  clearInterval(leaseHeartbeat)
  await updateServerLease(PORT, leaseToken, "release").catch(() => {})
  process.exit(code ?? 0)
})
process.on("SIGINT", () => tui.kill("SIGINT"))
process.on("SIGTERM", () => {
  tui.kill("SIGTERM")
})
