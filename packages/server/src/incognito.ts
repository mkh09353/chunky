import { loadSettings } from "./settings.ts"
import type { ModeSpec } from "./settings.ts"

type Scope = "normal" | "incognito" | "both"
const sessions = new Map<string, string[]>()

/** Remove process-local registrations (primarily useful for isolated tests). */
export function clearIncognitoSessions(): void { sessions.clear() }

export function isIncognitoSession(sessionId: string): boolean { return sessions.has(sessionId) }
export function incognitoAllowlistFor(sessionId: string): string[] | null {
  const allow = sessions.get(sessionId)
  return allow ? [...allow] : null
}
export function markSessionIncognito(sessionId: string, allow: string[]): void {
  sessions.set(sessionId, [...new Set(allow)])
}

export function providerScope(providerId: string): Scope {
  const provider = loadSettings().customProviders?.find((p) => p.id === providerId)
  return provider?.scope ?? "both"
}

export function assertSelectionAllowed(
  sessionId: string | null,
  selection: { provider: string; model?: string },
): void {
  const scope = providerScope(selection.provider)
  if (scope === "incognito" && (!sessionId || !isIncognitoSession(sessionId))) {
    throw new Error(`provider ${selection.provider} is incognito-only`)
  }
  if (sessionId && isIncognitoSession(sessionId)) {
    const allow = sessions.get(sessionId) ?? []
    if (!allow.includes(selection.provider)) {
      throw new Error(`provider ${selection.provider} not in incognito allowlist [${allow.join(", ")}]`)
    }
  }
}

/** Validate the provider references in an incognito mode. */
export function validateIncognitoMode(spec: ModeSpec): void {
  if (!spec.incognito) return
  const allow = [...new Set(spec.incognito.allow)]
  if (allow.length === 0) throw new Error("incognito mode allowlist must contain at least one provider")
  for (const provider of allow) {
    if (providerScope(provider) === "normal") {
      throw new Error(`incognito mode allowlist provider ${provider} has scope normal`)
    }
  }
  const refs: Array<[string, string]> = [["executor", spec.provider]]
  if (spec.advisor) refs.push(["advisor", spec.advisor.provider])
  if (spec.sidekick) refs.push(["sidekick", spec.sidekick.provider])
  for (const [name, seat] of Object.entries(spec.sidekickSeats ?? {})) refs.push([`sidekick seat ${name}`, seat.provider])
  for (const [name, provider] of refs) {
    if (!allow.includes(provider)) throw new Error(`incognito mode ${name} provider ${provider} is not in allowlist [${allow.join(", ")}]`)
  }
}

export function rehydrateIncognitoSessions(rows: Array<{ sessionId: string; incognito?: number | boolean; incognitoAllow?: string | null }>): void {
  for (const row of rows) {
    if (!row.incognito) continue
    try { markSessionIncognito(row.sessionId, JSON.parse(row.incognitoAllow ?? "[]")) } catch { markSessionIncognito(row.sessionId, []) }
  }
}

