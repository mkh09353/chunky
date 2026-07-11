// Native folder picker, bridged to the electrobun bun process over RPC.
//
// This ONLY works inside the packaged electrobun app, where `Electroview` sets
// up an encrypted socket to bun and `window.__electrobunRpcSocketPort` is set.
// In the plain dev browser (Vite at :5173) there is no bun process, so we never
// import electrobun/view (its internal `.js`→`.ts` imports would only resolve
// through the build) and pickFolder() returns null — callers fall back to the
// paste-a-path field. See bun/index.ts for the matching `openFolderDialog` RPC
// handler that calls the OS dialog.

/** True when running inside the electrobun webview (vs the dev browser). */
export function nativePickerAvailable(): boolean {
  return typeof window !== "undefined" && !!window.__electrobunRpcSocketPort
}

// The electrobun RPC client, lazily created once. `unknown` because we don't
// bundle electrobun's types into the webview app.
let rpcReady: Promise<{ request?: Record<string, (...a: unknown[]) => Promise<unknown>> } | null> | null =
  null

async function getRpc() {
  if (!nativePickerAvailable()) return null
  if (!rpcReady) {
    rpcReady = (async () => {
      try {
        // Dynamic + guarded: only loaded inside electrobun. Vite bundles it as a
        // lazy chunk (electrobunTsResolve resolves its `.js`→`.ts` deep imports).
        const mod = (await import("electrobun/view")) as {
          Electroview: new (c: { rpc: unknown }) => unknown
          createRPC: (opts: unknown) => unknown
        }
        const rpc = mod.createRPC({}) as {
          request?: Record<string, (...a: unknown[]) => Promise<unknown>>
        }
        new mod.Electroview({ rpc })
        return rpc
      } catch {
        return null
      }
    })()
  }
  return rpcReady
}

/**
 * Open the OS folder chooser and resolve to the selected absolute path, or null
 * when unavailable / cancelled. Callers should fall back to a path input on null.
 */
export async function pickFolder(): Promise<string | null> {
  try {
    console.log("[chunky] pickFolder: native available?", nativePickerAvailable())
    const rpc = await getRpc()
    console.log("[chunky] pickFolder: rpc ready?", !!rpc, "has openFolderDialog?", !!rpc?.request?.openFolderDialog)
    const fn = rpc?.request?.openFolderDialog
    if (!fn) return null
    const path = await fn()
    console.log("[chunky] pickFolder: dialog returned", path)
    return typeof path === "string" && path.trim() ? path.trim() : null
  } catch (err) {
    console.log("[chunky] pickFolder: error", (err as Error)?.message)
    return null
  }
}
