import { mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { BrowserWindow, Updater, createRPC, Utils } from "electrobun/bun"

const DEV_SERVER_PORT = 5173
const DEV_SERVER_URL = process.env.VITE_DEV_URL ?? `http://localhost:${DEV_SERVER_PORT}`

const here = dirname(fileURLToPath(import.meta.url))
const appRoot = join(here, "../..")

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

const baseUrl =
  process.env.CHUNKY_URL || `http://localhost:${process.env.CHUNKY_PORT || 4599}`
const workspace = process.env.CHUNKY_WORKSPACE || process.cwd()
const workspaceName = workspace.split(/[\\/]/).filter(Boolean).pop() || "workspace"

const config = { baseUrl, workspace, workspaceName }
const configJson = JSON.stringify(config, null, 2)

// Vite serves public/ at /; also drop a copy next to built assets for canary.
for (const rel of ["src/mainview/public/chunky-config.json", "dist/chunky-config.json"]) {
  try {
    const path = join(appRoot, rel)
    mkdirSync(dirname(path), { recursive: true })
    await Bun.write(path, configJson)
  } catch (err) {
    console.warn(`[@chunky/app] could not write ${rel}`, err)
  }
}

const url = await getMainViewUrl()

// RPC bridge for the webview's "Add repo → Browse…" button. The webview
// (lib/pickFolder.ts) calls `openFolderDialog`; we show the native OS folder
// chooser and return the selected absolute path (or "" if cancelled).
const rpc = createRPC({
  requestHandler: {
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
