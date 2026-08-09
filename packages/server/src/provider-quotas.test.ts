import { describe, expect, test } from "bun:test"
import { createProviderQuotaService, PROVIDER_QUOTA_TTL_MS } from "./provider-quotas.ts"

const available = (usedPercent: number) => Promise.resolve({
  status: "available" as const,
  source: "codex-usage" as const,
  fetchedAt: 1,
  windows: [{ kind: "five-hour" as const, label: "5-hour", usedPercent, resetAt: 2 }],
})

describe("provider quota aggregation", () => {
  test("coalesces concurrent refreshes and observes the two-minute TTL", async () => {
    let now = 10_000, calls = 0, release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const service = createProviderQuotaService({
      now: () => now,
      ready: () => true,
      billing: () => "subscription",
      collectors: {
        codex: async () => { calls++; await gate; return available(10) },
        anthropic: async () => { calls++; await gate; return { ...(await available(20)), source: "anthropic-sdk" } },
      },
    })
    const first = service.get(), second = service.get()
    expect(calls).toBe(2)
    release()
    expect(await second).toBe(await first)
    await service.get()
    expect(calls).toBe(2)
    now += PROVIDER_QUOTA_TTL_MS + 1
    await service.get()
    expect(calls).toBe(4)
  })

  test("isolates provider failures and returns logged-out rows", async () => {
    const service = createProviderQuotaService({
      ready: (provider) => provider === "codex",
      billing: () => "subscription",
      collectors: { codex: async () => { throw new Error("codex down") } },
      passiveCodex: () => undefined,
    })
    const result = await service.get()
    expect(result.providers).toEqual([
      { provider: "codex", billing: "subscription", status: "error", source: null, fetchedAt: null, windows: [], error: "codex down" },
      { provider: "anthropic", billing: "subscription", status: "not-authenticated", source: null, fetchedAt: null, windows: [] },
    ])
  })

  test("returns stale prior data and passive Codex headers when direct refresh fails", async () => {
    let now = 0, fail = false
    const service = createProviderQuotaService({
      now: () => now,
      ready: () => true,
      billing: () => "subscription",
      collectors: {
        codex: () => fail ? Promise.reject(new Error("direct failed")) : available(33),
        anthropic: async () => ({ status: "unsupported", source: "anthropic-sdk", fetchedAt: 1, windows: [] }),
      },
    })
    await service.get()
    fail = true; now += PROVIDER_QUOTA_TTL_MS + 1
    const stale = await service.get()
    expect(stale.providers[0]).toMatchObject({ status: "stale", source: "codex-usage", error: "direct failed", windows: [{ usedPercent: 33 }] })

    const passive = createProviderQuotaService({
      ready: () => true,
      billing: () => "subscription",
      collectors: { codex: async () => { throw new Error("direct failed") }, anthropic: async () => ({ status: "unsupported", source: "anthropic-sdk", fetchedAt: 1, windows: [] }) },
      passiveCodex: () => ({ fetchedAt: 99, windows: [{ kind: "weekly", label: "Weekly", usedPercent: 9, resetAt: 100 }] }),
    })
    expect((await passive.get()).providers[0]).toMatchObject({ status: "stale", source: "response-headers", fetchedAt: 99, windows: [{ usedPercent: 9 }] })
  })
})
