import type { AppBrowserAnnounce, AppBrowserEndpoint } from "@chunky/protocol"

let endpoint: AppBrowserEndpoint | null = null
export function getAppBrowserEndpoint(): AppBrowserEndpoint | null { return endpoint }
export function setAppBrowserEndpoint(announce: AppBrowserAnnounce): AppBrowserEndpoint {
  const port = Number(announce.cdpPort)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("cdpPort must be a valid TCP port")
  const renderer = announce.renderer === "cef" ? "cef" : "native"
  endpoint = { cdpPort: port, cdpUrl: `http://127.0.0.1:${port}`, renderer, debuggable: renderer === "cef" && announce.debuggable !== false, announcedAt: Date.now() }
  return endpoint
}
export function resetAppBrowserEndpoint(): void { endpoint = null }
