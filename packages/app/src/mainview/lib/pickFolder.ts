// Native folder picker, bridged to the electrobun bun process over RPC.
//
// Only works inside the electrobun webview (see lib/rpc.ts); in the plain dev
// browser pickFolder() returns null — callers fall back to the paste-a-path
// field. See bun/index.ts for the matching `openFolderDialog` RPC handler that
// calls the OS dialog.
import { getRpc, nativeRpcAvailable } from "./rpc"

/** True when running inside the electrobun webview (vs the dev browser). */
export function nativePickerAvailable(): boolean {
  return nativeRpcAvailable()
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
