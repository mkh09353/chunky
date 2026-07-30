import type { AppZooAnnounce } from "@chunky/protocol"

export type AppZooEndpoint = { port: number; token: string; announcedAt: number }

let endpoint: AppZooEndpoint | null = null
const listeners = new Set<(connected: boolean) => void>()

export function getAppZooEndpoint(): AppZooEndpoint | null { return endpoint }
export function hasAppZoo(): boolean { return endpoint != null }

/** Subscribe to availability changes. Re-announcements while connected are no-ops. */
export function onAppZooChange(listener: (connected: boolean) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function notify(wasConnected: boolean): void {
  const connected = hasAppZoo()
  if (connected !== wasConnected) for (const listener of listeners) listener(connected)
}

export function setAppZooEndpoint(announce: AppZooAnnounce): void {
  const wasConnected = hasAppZoo()
  const port = Number(announce.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("port must be a valid TCP port")
  if (typeof announce.token !== "string" || announce.token.length < 16) throw new Error("token must be at least 16 characters")
  endpoint = { port, token: announce.token, announcedAt: Date.now() }
  notify(wasConnected)
}

export function resetAppZooEndpoint(): void {
  const wasConnected = hasAppZoo()
  endpoint = null
  notify(wasConnected)
}
