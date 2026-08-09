import type { ProviderQuota, ProviderQuotasResponse } from "@chunky/protocol"
import { fetchAnthropicQuota } from "./providers/anthropic-sdk.ts"
import { currentCodexPassiveQuota, fetchCodexQuota } from "./providers/codex.ts"
import { getProvider } from "./providers/registry.ts"
import type { CollectedProviderQuota } from "./providers/quota-types.ts"

export const PROVIDER_QUOTA_TTL_MS = 2 * 60_000
export const PROVIDER_QUOTA_TIMEOUT_MS = 10_000

type ProviderId = "codex" | "anthropic"
type Billing = ProviderQuota["billing"]
type Collector = () => Promise<CollectedProviderQuota>

export interface ProviderQuotaServiceDependencies {
  now?: () => number
  timeoutMs?: number
  ready?: (provider: ProviderId) => boolean
  billing?: (provider: ProviderId) => Billing
  collectors?: Partial<Record<ProviderId, Collector>>
  passiveCodex?: typeof currentCodexPassiveQuota
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Provider quota request failed"
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, provider: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${provider} quota request timed out`)), timeoutMs)
    timer.unref?.()
    promise.then(resolve, reject).finally(() => clearTimeout(timer))
  })
}

export function createProviderQuotaService(dependencies: ProviderQuotaServiceDependencies = {}) {
  const now = dependencies.now ?? Date.now
  const ready = dependencies.ready ?? ((provider: ProviderId) => getProvider(provider)?.ready() ?? false)
  const billing = dependencies.billing ?? ((provider: ProviderId) => {
    const value = getProvider(provider)?.billing
    return value === "subscription" ? "subscription" : value === "metered" ? "api-key" : null
  })
  const collectors: Record<ProviderId, Collector> = {
    codex: dependencies.collectors?.codex ?? (() => fetchCodexQuota()),
    anthropic: dependencies.collectors?.anthropic ?? (() => fetchAnthropicQuota()),
  }
  const passiveCodex = dependencies.passiveCodex ?? currentCodexPassiveQuota
  const timeoutMs = dependencies.timeoutMs ?? PROVIDER_QUOTA_TIMEOUT_MS
  let latest: ProviderQuotasResponse | undefined
  let activeRefresh: Promise<ProviderQuotasResponse> | undefined

  const base = (provider: ProviderId, quota: CollectedProviderQuota): ProviderQuota => ({
    provider,
    billing: billing(provider),
    ...quota,
  })

  async function collect(provider: ProviderId, previous?: ProviderQuota): Promise<ProviderQuota> {
    if (!ready(provider)) {
      return { provider, billing: billing(provider), status: "not-authenticated", source: null, fetchedAt: null, windows: [] }
    }
    try {
      return base(provider, await withTimeout(collectors[provider](), timeoutMs, provider))
    } catch (error) {
      if (previous && (previous.status === "available" || previous.status === "stale" || previous.status === "unsupported")) {
        return { ...previous, status: "stale", error: errorMessage(error) }
      }
      if (provider === "codex") {
        const passive = passiveCodex()
        if (passive) {
          return { provider, billing: billing(provider), status: "stale", source: "response-headers", fetchedAt: passive.fetchedAt, windows: passive.windows, error: errorMessage(error) }
        }
      }
      return { provider, billing: billing(provider), status: "error", source: null, fetchedAt: null, windows: [], error: errorMessage(error) }
    }
  }

  async function refresh(): Promise<ProviderQuotasResponse> {
    const previous = new Map(latest?.providers.map((row) => [row.provider, row]))
    const providers = await Promise.all(((["codex", "anthropic"] as const)).map((provider) => collect(provider, previous.get(provider))))
    const response = { fetchedAt: now(), providers }
    latest = response
    return response
  }

  return {
    get(): Promise<ProviderQuotasResponse> {
      if (latest && now() - latest.fetchedAt < PROVIDER_QUOTA_TTL_MS) return Promise.resolve(latest)
      if (!activeRefresh) {
        activeRefresh = refresh().finally(() => { activeRefresh = undefined })
      }
      return activeRefresh
    },
    reset(): void { latest = undefined; activeRefresh = undefined },
  }
}

const providerQuotaService = createProviderQuotaService()
export function providerQuotas(): Promise<ProviderQuotasResponse> { return providerQuotaService.get() }
