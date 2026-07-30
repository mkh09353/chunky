import type { AppBrowserAnnounce, AppBrowserEndpoint } from "@chunky/protocol"

export type AppBrowserTier = "open" | "cdp" | undefined

let endpoint: AppBrowserEndpoint | null = null
const tierListeners = new Set<(tier: AppBrowserTier) => void>()

export function getAppBrowserEndpoint(): AppBrowserEndpoint | null { return endpoint }
/** The one capability tier shared by prompts and tool registration. */
export function appBrowserTier(): AppBrowserTier {
  return endpoint ? endpoint.debuggable ? "cdp" : "open" : undefined
}
/** Subscribe to real capability changes. Re-announcements in the same tier do nothing. */
export function onAppBrowserTierChange(listener: (tier: AppBrowserTier) => void): () => void {
  tierListeners.add(listener)
  return () => tierListeners.delete(listener)
}
function notifyTierChange(previous: AppBrowserTier): void {
  const tier = appBrowserTier()
  if (tier !== previous) for (const listener of tierListeners) listener(tier)
}
export function setAppBrowserEndpoint(announce: AppBrowserAnnounce): AppBrowserEndpoint {
  const previous = appBrowserTier()
  const port = Number(announce.cdpPort)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("cdpPort must be a valid TCP port")
  const renderer = announce.renderer === "cef" ? "cef" : "native"
  endpoint = { cdpPort: port, cdpUrl: `http://127.0.0.1:${port}`, renderer, debuggable: renderer === "cef" && announce.debuggable !== false, announcedAt: Date.now() }
  notifyTierChange(previous)
  return endpoint
}
export function resetAppBrowserEndpoint(): void {
  const previous = appBrowserTier()
  endpoint = null
  notifyTierChange(previous)
}
