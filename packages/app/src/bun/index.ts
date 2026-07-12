import { BrowserWindow, Updater, createRPC, Utils } from "electrobun/bun"

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

// Served to the webview over the `getConfig` RPC below. (We used to also write
// chunky-config.json copies at startup, but bundled bun runs from inside the
// .app, so those writes landed in Resources/{src,dist}/ — paths neither Vite
// HMR nor the views:// server ever reads. The static public/chunky-config.json
// stays as a dev-browser fallback only.)
const config = { baseUrl, workspace, workspaceName }

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
      console.log("[@chunky/app] openFolderDialog RPC received — opening native dialog")
      const paths = await Utils.openFileDialog({
        startingFolder: workspace,
        canChooseFiles: false,
        canChooseDirectory: true,
        allowsMultipleSelection: false,
      })
      const picked = paths.find((p) => p && p.trim()) ?? ""
      console.log(`[@chunky/app] openFolderDialog returning: ${picked || "(cancelled)"}`)
      return picked
    },
  },
})

new BrowserWindow({
  title: "Chunky",
  url,
  rpc,
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
})

console.log(`[@chunky/app] window ready — harness ${baseUrl}`)
console.log(`[@chunky/app] workspace ${workspace}`)
