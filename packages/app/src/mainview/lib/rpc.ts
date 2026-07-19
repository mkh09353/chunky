// Shared electrobun RPC client for the webview (folder picker, config, …).
//
// This ONLY works inside the electrobun app, where `Electroview` sets up an
// encrypted socket to bun and `window.__electrobunRpcSocketPort` is set. In the
// plain dev browser (Vite at :5173) there is no bun process, so we never import
// electrobun/view (its internal `.js`→`.ts` imports would only resolve through
// the build) and getRpc() resolves null — callers fall back gracefully. See
// bun/index.ts for the matching request handlers.

/** True when running inside the electrobun webview (vs the dev browser). */
export function nativeRpcAvailable(): boolean {
  return typeof window !== "undefined" && !!window.__electrobunRpcSocketPort
}

// `unknown`-ish shape because we don't bundle electrobun's types into the
// webview app.
export type RpcClient = {
  request?: Record<string, (...a: unknown[]) => Promise<unknown>>
  // Incoming push messages from bun (`{ type: "message", id, payload }`).
  // "*" is a wildcard: (messageName, payload).
  addMessageListener?: (
    message: string,
    listener: (...a: unknown[]) => void,
  ) => void
}

// The electrobun RPC client, lazily created once. A single shared instance —
// electrobun's Electroview must only be constructed once per webview.
let rpcReady: Promise<RpcClient | null> | null = null

/**
 * Open `url` in the user's default browser. Inside electrobun this goes over
 * RPC to the bun process (`open`/`xdg-open`); in the plain dev browser it falls
 * back to window.open. Returns false when nothing could be opened.
 */
export async function openExternal(url: string): Promise<boolean> {
  if (!/^https?:\/\//i.test(url)) return false
  try {
    const rpc = await getRpc()
    const fn = rpc?.request?.openExternal
    if (fn) {
      await fn(url)
      return true
    }
  } catch {
    /* fall through to window.open */
  }
  try {
    return window.open(url, "_blank", "noopener") != null
  } catch {
    return false
  }
}

export async function getRpc(): Promise<RpcClient | null> {
  if (!nativeRpcAvailable()) return null
  if (!rpcReady) {
    rpcReady = (async () => {
      try {
        // Dynamic + guarded: only loaded inside electrobun. Vite bundles it as a
        // lazy chunk (electrobunTsResolve resolves its `.js`→`.ts` deep imports).
        const mod = (await import("electrobun/view")) as {
          Electroview: new (c: { rpc: unknown }) => unknown
          createRPC: (opts: unknown) => unknown
        }
        // maxRequestTime: the OS folder chooser is modal and open-ended, but
        // electrobun's RPC rejects requests after 1s by default — long before
        // anyone can pick a folder. Infinity disables the timer (explicitly
        // supported); a missing bun-side handler still rejects immediately.
        const rpc = mod.createRPC({ maxRequestTime: Infinity }) as RpcClient
        new mod.Electroview({ rpc })
        return rpc
      } catch {
        return null
      }
    })()
  }
  return rpcReady
}
