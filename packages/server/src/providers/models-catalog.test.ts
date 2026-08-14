import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MODEL_PRICING, isCatalogModelId, pricingFor, pricingForCatalog, resolveCatalogModelId, type DevCatalog } from "./models-catalog.ts"

const price = (input: number, output = input * 2) => ({ input, output, cache_read: input / 10, cache_write: input * 1.25 })
const catalog = (models: Record<string, { cost: ReturnType<typeof price> }>): DevCatalog => ({ test: { models } })

describe("models.dev pricing", () => {
  test("prefers an exact models.dev match over substring and static pricing", () => {
    const data = catalog({
      "gpt-4o": { cost: price(99) },
      "gpt-4o-current": { cost: price(7) },
    })
    expect(pricingForCatalog("gpt-4o-current", data)?.input).toBe(7)
    expect(pricingForCatalog("gpt-4o", data)?.input).toBe(99)
  })

  test("uses the longest and most specific substring match", () => {
    const data = catalog({
      "gpt-5": { cost: price(5) },
      "gpt-5.6": { cost: price(56) },
      "gpt-5.6-luna": { cost: price(1) },
    })
    expect(pricingForCatalog("openai/gpt-5.6-luna-20260808", data)?.input).toBe(1)
  })

  test("falls back to the static catalog", () => {
    expect(pricingForCatalog("release/gpt-4o-2024", {})).toEqual(MODEL_PRICING["gpt-4o"])
  })

  test("a missing disk cache is synchronous, network-free, and returns no guessed price", () => {
    const dir = mkdtempSync(join(tmpdir(), "chunky-model-pricing-"))
    const previous = process.env.CHUNKY_MODELS_CACHE
    process.env.CHUNKY_MODELS_CACHE = join(dir, "missing.json")
    try {
      expect(pricingFor("not-in-static-or-cache")).toBeUndefined()
      expect(pricingFor("gpt-4o")).toEqual(MODEL_PRICING["gpt-4o"])
    } finally {
      if (previous == null) delete process.env.CHUNKY_MODELS_CACHE
      else process.env.CHUNKY_MODELS_CACHE = previous
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

const aliasCatalog = (ids: string[]): DevCatalog => ({
  anthropic: { models: Object.fromEntries(ids.map((id) => [id, { id, name: id }])) },
})

describe("resolveCatalogModelId", () => {
  const catalog = aliasCatalog(["claude-opus-5", "claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5", "claude-fable-5"])

  test("resolves family aliases and preserves a [1m] suffix", () => {
    expect(resolveCatalogModelId("opus[1m]", catalog)).toBe("claude-opus-5[1m]")
    expect(resolveCatalogModelId("opus", catalog)).toBe("claude-opus-5")
    expect(resolveCatalogModelId("sonnet[1m]", catalog)).toBe("claude-sonnet-5[1m]")
    expect(resolveCatalogModelId("haiku", catalog)).toBe("claude-haiku-4-5")
    expect(resolveCatalogModelId("fable[1m]", catalog)).toBe("claude-fable-5[1m]")
  })

  test("leaves canonical ids and unknown names untouched", () => {
    expect(resolveCatalogModelId("claude-opus-5[1m]", catalog)).toBe("claude-opus-5[1m]")
    expect(resolveCatalogModelId("claude-opus-4-8", catalog)).toBe("claude-opus-4-8")
    expect(resolveCatalogModelId("mystery-model", catalog)).toBe("mystery-model")
    expect(resolveCatalogModelId("mystery[1m]", catalog)).toBe("mystery[1m]")
  })

  test("treats a catalog id plus [1m] as already canonical", () => {
    expect(isCatalogModelId("claude-opus-5[1m]", catalog)).toBe(true)
    expect(isCatalogModelId("opus[1m]", catalog)).toBe(false)
    expect(isCatalogModelId("not-in-catalog", catalog)).toBe(false)
  })

  test("falls back to the current family id when the catalog is empty", () => {
    expect(resolveCatalogModelId("opus[1m]", {})).toBe("claude-opus-5[1m]")
    expect(resolveCatalogModelId("sonnet", {})).toBe("claude-sonnet-5")
  })
})
