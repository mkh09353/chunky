import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MODEL_PRICING, pricingFor, pricingForCatalog, type DevCatalog } from "./models-catalog.ts"

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
