import { randomUUID } from "node:crypto"
import type { ProviderKeyRequest, ProviderKeyResponse } from "@chunky/protocol"
import { emitLiveToSession } from "./session-bus.ts"
import { AuthStore } from "./providers/auth-store.ts"

export type ProviderKeyRequestResult = "stored" | "cancelled" | "timeout"

interface PendingRequest {
  providerId: string
  resolve: (result: ProviderKeyRequestResult) => void
  timer: ReturnType<typeof setTimeout>
}

const pending = new Map<string, PendingRequest>()
const REQUEST_TIMEOUT_MS = 180_000

function finish(requestId: string, result: ProviderKeyRequestResult): boolean {
  const request = pending.get(requestId)
  if (!request) return false
  pending.delete(requestId)
  clearTimeout(request.timer)
  request.resolve(result)
  return true
}

/** Request a key from the desktop attached to a session. The key itself returns
 * through the authenticated provider-key route and is never placed on SSE. */
export function createKeyRequest(providerId: string, label: string, sessionId: string): Promise<ProviderKeyRequestResult> {
  const requestId = randomUUID()
  const promise = new Promise<ProviderKeyRequestResult>((resolve) => {
    const timer = setTimeout(() => finish(requestId, "timeout"), REQUEST_TIMEOUT_MS)
    timer.unref?.()
    pending.set(requestId, { providerId, resolve, timer })
  })
  try {
    emitLiveToSession(sessionId, { type: "app.request_api_key", requestId, providerId, label })
  } catch (error) {
    finish(requestId, "cancelled")
    throw error
  }
  return promise
}

/** Store/cancel a desktop submission and settle matching pending requests. */
export function submitProviderKey(providerId: string, body: ProviderKeyRequest): ProviderKeyResponse {
  const key = typeof body.key === "string" ? body.key : ""
  if (key.trim()) {
    AuthStore.set(providerId, { type: "api", key })
    for (const [requestId, request] of pending) {
      if (request.providerId === providerId) finish(requestId, "stored")
    }
    return { ok: true }
  }
  if (body.requestId) {
    const request = pending.get(body.requestId)
    if (request?.providerId === providerId) finish(body.requestId, "cancelled")
  }
  return { ok: true }
}

/** Test seam: settle pending timers without waiting for the production timeout. */
export function timeoutKeyRequestForTest(requestId: string): boolean {
  return finish(requestId, "timeout")
}

/** Test seam: inspect only opaque request ids, never submitted secrets. */
export function pendingKeyRequestIdsForTest(): string[] {
  return [...pending.keys()]
}
