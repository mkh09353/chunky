import { BrowserWindow, Updater, createRPC, Utils, ApplicationMenu, app, BuildConfig } from "electrobun/bun"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { ROUTES, type AppBrowserAnnounce } from "@chunky/protocol"
import { TerminalManager } from "./terminal-manager"
import type { TerminalAckRequest, TerminalOpenRequest, TerminalResizeRequest, TerminalWriteRequest } from "../shared/terminal"

const DEV_SERVER_PORT = 5173
const DEV_SERVER_URL = process.env.VITE_DEV_URL ?? `http://localhost:${DEV_SERVER_PORT}`

async function getMainViewUrl(): Promise<string> {
  // Prefer Vite HMR when reachable (dev workflow).
  try {
    await fetch(DEV_SERVER_URL, { method: "HEAD" })
    console.log(`[@chunky/app] HMR: ${DEV_SERVER_URL}`)
    return DEV_SERVER_URL
  } catch {
    /* fall through to bundled view */
  }

  try {
    const channel = await Updater.localInfo.channel()
    if (channel === "dev") {
      console.log("[@chunky/app] Vite HMR not running — loading bundled view")
    }
  } catch {
    /* ignore */
  }
  return "views://mainview/index.html"
}

// The chunky harness (server) URL. Dev builds default to the DEV port 4620 —
// the same port `bun run server` (scripts/dev-server.ts) and the dev TUI use, so
// the whole dev stack agrees without relying on env reaching the app bundle
// (electrobun doesn't forward CHUNKY_PORT into the launched .app). An explicit
// CHUNKY_URL / CHUNKY_PORT still wins — e.g. an installed launcher pinning a
// free port (chunky.ts), which is never 4620/4599.
const baseUrl =
  process.env.CHUNKY_URL || `http://localhost:${process.env.CHUNKY_PORT || 4620}`
const workspace = process.env.CHUNKY_WORKSPACE || process.cwd()
const workspaceName = workspace.split(/[\\/]/).filter(Boolean).pop() || "workspace"
function serverToken(): string | undefined {
  try {
    const raw = readFileSync(process.env.CHUNKY_SETTINGS || join(homedir(), ".chunky", "state", "settings.json"), "utf8")
    return (JSON.parse(raw) as { serverToken?: unknown }).serverToken as string | undefined
  } catch { return undefined }
}

// Served to the webview over the `getConfig` RPC below. (We used to also write
// chunky-config.json copies at startup, but bundled bun runs from inside the
// .app, so those writes landed in Resources/{src,dist}/ — paths neither Vite
// HMR nor the views:// server ever reads. The static public/chunky-config.json
// stays as a dev-browser fallback only.)
// The browser pane's Chrome DevTools Protocol port. Must agree with the
// `remote-debugging-port` chromiumFlag in electrobun.config.ts, which reads the
// same env var at build time — they're baked separately, so overriding it means
// rebuilding, not just relaunching.
const cdpPort = Number(process.env.CHUNKY_CDP_PORT || 9223)

// Whether this build actually shipped CEF. `availableRenderers` comes from the
// bundle's Resources/build.json, which the electrobun CLI writes from
// build.mac.bundleCEF — so it's the honest answer to "can a webview ask for the
// cef renderer here?", rather than us assuming the config we wrote took effect.
//
// Falls back to native-only when build.json can't be read (BuildConfig's own
// dev-mode fallback), which is the safe direction: the pane still works, it just
// isn't CDP-drivable. CHUNKY_FORCE_CEF=1 overrides for debugging that case.
const buildInfo = await BuildConfig.get().catch(() => null)
const cefAvailable =
  process.env.CHUNKY_FORCE_CEF === "1" ||
  (buildInfo?.availableRenderers?.includes("cef") ?? false)

const config = { baseUrl, workspace, workspaceName, cefAvailable, cdpPort, serverToken: serverToken() }
const terminalManager = new TerminalManager(workspace || process.env.HOME || process.cwd())

// macOS routes ⌘C/⌘V/⌘X/⌘A through the app menu's key-equivalents — the standard
// Edit → Copy item fires `copy:` on the focused WKWebView. Electrobun (unlike
// Electron) installs NO default menu, so without this, ⌘C is a no-op and users
// can't copy selected transcript text. The `role`s below map to the native
// NSResponder selectors that make selection editing "just work".
ApplicationMenu.setApplicationMenu([
  {
    label: "Chunky",
    submenu: [
      { role: "about" },
      { type: "separator" },
      { role: "hide", accelerator: "CommandOrControl+H" },
      { role: "hideOthers", accelerator: "CommandOrControl+Alt+H" },
      { role: "showAll" },
      { type: "separator" },
      { role: "quit", accelerator: "CommandOrControl+Q" },
    ],
  },
  {
    label: "Edit",
    submenu: [
      { role: "undo", accelerator: "CommandOrControl+Z" },
      { role: "redo", accelerator: "CommandOrControl+Shift+Z" },
      { type: "separator" },
      { role: "cut", accelerator: "CommandOrControl+X" },
      { role: "copy", accelerator: "CommandOrControl+C" },
      { role: "paste", accelerator: "CommandOrControl+V" },
      { role: "pasteAndMatchStyle", accelerator: "CommandOrControl+Shift+V" },
      { role: "delete" },
      { role: "selectAll", accelerator: "CommandOrControl+A" },
    ],
  },
  {
    label: "Window",
    submenu: [
      { role: "minimize", accelerator: "CommandOrControl+M" },
      { role: "zoom" },
      { role: "close", accelerator: "CommandOrControl+W" },
      { type: "separator" },
      { role: "toggleFullScreen" },
    ],
  },
])

const url = await getMainViewUrl()

// RPC bridge for the webview's "Add repo → Browse…" button. The webview
// (lib/pickFolder.ts) calls `openFolderDialog`; we show the native OS folder
// chooser and return the selected absolute path (or "" if cancelled).
const rpc = createRPC({
  requestHandler: {
    // The webview's source of truth for the harness URL/workspace (lib/api.ts
    // loadConfig). Static chunky-config.json copies can't track env overrides.
    getConfig: async () => config,
    // Open a URL in the user's default browser (the /login flow) — the webview
    // itself can't reach outside its window.
    openExternal: async (url: unknown) => {
      if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return false
      const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open"
      try {
        await Bun.spawn([opener, url], { stdout: "ignore", stderr: "ignore" }).exited
        return true
      } catch {
        return false
      }
    },
    openFolderDialog: async () => {
      const paths = await Utils.openFileDialog({
        startingFolder: workspace,
        canChooseFiles: false,
        canChooseDirectory: true,
        allowsMultipleSelection: false,
      })
      const picked = paths.find((p) => p && p.trim()) ?? ""
      return picked
    },
    terminalOpen: (req: TerminalOpenRequest) => terminalManager.open(req),
    terminalWrite: (req: TerminalWriteRequest) => terminalManager.write(req),
    terminalResize: (req: TerminalResizeRequest) => terminalManager.resize(req),
    terminalClose: (req: { terminalId: string }) => terminalManager.close(req.terminalId),
    terminalList: () => terminalManager.list(),
    terminalAck: (req: TerminalAckRequest) => terminalManager.ack(req),
  },
})

const window = new BrowserWindow({
  title: "Chunky",
  url,
  rpc,
  // The app chrome stays on the system WebView even in CEF-bundled builds. Only
  // the browser pane opts into Chromium (see components/BrowserPane.tsx); this
  // is pinned rather than left to the build default so that flipping
  // `defaultRenderer` later can't silently drag the whole UI onto CEF.
  renderer: "native",
  // Codex-style chrome: no separate OS title bar. `hiddenInset` makes the
  // titlebar transparent and extends our webview to the very top of the window
  // (FullSizeContentView), so the app reads as one smooth surface. The native
  // traffic lights float inset over the top-left of our TopNav; the offset nudges
  // them down to sit vertically centred in that ~52px header row. The webview
  // reserves left clearance for them via the `.chunky-shell` padding in index.css.
  titleBarStyle: "hiddenInset",
  trafficLightOffset: { x: 12, y: 14 },
  frame: {
    width: 1280,
    height: 860,
    x: 80,
    y: 60,
  },
  minWidth: 720,
  minHeight: 520,
})

// Electrobun's Bun-side RPC send proxy is the supported push channel. The
// manager deliberately only knows this tiny interface, keeping terminal
// process lifetime independent from the BrowserWindow implementation.
terminalManager.setWebview({ rpc: { send: (name, payload) => rpc.send(name, payload) } })
app.on("before-quit", () => terminalManager.cleanup())

console.log(`[@chunky/app] window ready — harness ${baseUrl}`)
console.log(`[@chunky/app] workspace ${workspace}`)
console.log(
  cefAvailable
    ? `[@chunky/app] browser pane: CEF, CDP on http://127.0.0.1:${cdpPort}`
    : "[@chunky/app] browser pane: system WebView (no CEF in this build — CDP unavailable)",
)

/**
 * Tell the harness where the browser pane's CDP endpoint is, so agent tooling
 * can drive the pane the user is actually looking at.
 *
 * Retried with backoff because the app frequently wins the startup race against
 * the server, and best-effort because a missing announcement must never stop the
 * app from opening — the pane itself works regardless.
 */
async function announceBrowserEndpoint(): Promise<void> {
  const body: AppBrowserAnnounce = {
    cdpPort,
    renderer: cefAvailable ? "cef" : "native",
    debuggable: cefAvailable,
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(`${baseUrl}${ROUTES.appBrowser}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
      if (res.ok) {
        console.log(`[@chunky/app] announced browser endpoint to ${baseUrl}`)
        return
      }
    } catch {
      /* server not up yet */
    }
    await new Promise((r) => setTimeout(r, 500 * 2 ** attempt))
  }
  console.log("[@chunky/app] could not announce browser endpoint (harness unreachable)")
}

void announceBrowserEndpoint()
