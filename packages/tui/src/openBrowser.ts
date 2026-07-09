// Open a URL in the user's default browser. TUI + server run locally, so this
// launches the browser on the same machine the OAuth loopback callback binds to.
import { spawn } from "node:child_process"

export function openBrowser(url: string): boolean {
  try {
    const platform = process.platform
    const [cmd, args] =
      platform === "darwin"
        ? ["open", [url]]
        : platform === "win32"
          ? ["cmd", ["/c", "start", "", url]]
          : ["xdg-open", [url]]
    const child = spawn(cmd, args as string[], { detached: true, stdio: "ignore" })
    child.unref()
    return true
  } catch {
    return false
  }
}
