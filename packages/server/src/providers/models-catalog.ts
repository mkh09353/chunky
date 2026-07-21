// Model capability catalog — the metadata layer behind the /model picker.
//
// A provider's `listModels()` knows only the model *ids* it can serve (Zen from
// its live /v1/models endpoint; Codex/Grok from a curated list). This module
// turns those bare ids into rich `ModelInfo` by matching them against the
// models.dev catalog (https://models.dev/api.json), which carries per-model
// `reasoning` / display `name` / context `limit`. The `reasoning` flag is what
// the TUI uses to decide whether to offer an effort sub-picker.
//
// The models.dev fetch is cached in-memory for the process AND written to a
// small on-disk file (CHUNKY_MODELS_CACHE || "models-dev-cache.json") with a TTL so
// repeated runs don't re-hit the network. If the fetch fails and no cache
// exists, enrichment degrades gracefully: reasoning=false, name=id.
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { CHUNKY_USER_AGENT } from "./app-info.ts"

/** The shape every provider's listModels() returns and the picker consumes. */
export interface ModelInfo {
  id: string
  name: string
  reasoning: boolean
  contextLimit?: number
  /** User-added rather than currently advertised/built in. */
  custom?: boolean
  /** False when a custom id could not be verified before saving. */
  verified?: boolean
}

/** USD per million tokens.  This deliberately remains a small, conservative
 * table: unknown models are recorded without a guessed price. */
export interface ModelPricing { input: number; output: number; cacheRead: number; cacheWrite: number }
export const MODEL_PRICING: Record<string, ModelPricing> = {
  "gpt-4o": { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 1.25 },
  "claude-3-5-sonnet": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-sonnet-4": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "gemini-2.5-pro": { input: 1.25, output: 10, cacheRead: 0.3125, cacheWrite: 0.3125 },
}
export function pricingFor(model: string): ModelPricing | undefined {
  return MODEL_PRICING[model] ?? Object.entries(MODEL_PRICING).find(([id]) => model.includes(id))?.[1]
}

const MODELS_DEV_URL = "https://models.dev/api.json"
const CACHE_TTL_MS = 24 * 60 * 60 * 1000 // 24h

// Minimal slice of the models.dev schema we care about (see opencode's
// packages/core/src/models-dev.ts for the full Schema).
interface DevModel {
  id?: string
  name?: string
  reasoning?: boolean
  limit?: { context?: number }
}
interface DevProvider {
  id?: string
  models?: Record<string, DevModel>
}
type DevCatalog = Record<string, DevProvider>

function cachePath(): string {
  return process.env.CHUNKY_MODELS_CACHE || "models-dev-cache.json"
}

// Process-lifetime memo of the in-flight/complete fetch so concurrent callers
// (all three providers listing at once) share ONE network round-trip.
let inFlight: Promise<DevCatalog> | undefined

function readDiskCache(): DevCatalog | undefined {
  const p = cachePath()
  if (!existsSync(p)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as { fetchedAt?: number; catalog?: DevCatalog }
    if (!parsed?.catalog || typeof parsed.fetchedAt !== "number") return undefined
    if (Date.now() - parsed.fetchedAt > CACHE_TTL_MS) return undefined
    return parsed.catalog
  } catch {
    return undefined
  }
}

function writeDiskCache(catalog: DevCatalog): void {
  try {
    writeFileSync(cachePath(), JSON.stringify({ fetchedAt: Date.now(), catalog }))
  } catch {
    // best-effort; the in-memory memo still serves this process
  }
}

/** Fetch (or reuse) the models.dev catalog. Cached in-memory + on disk. */
export function loadModelsDev(): Promise<DevCatalog> {
  if (inFlight) return inFlight
  inFlight = (async () => {
    const disk = readDiskCache()
    if (disk) return disk
    try {
      const res = await fetch(MODELS_DEV_URL, { headers: { "User-Agent": CHUNKY_USER_AGENT } })
      if (!res.ok) throw new Error(`models.dev returned ${res.status}`)
      const catalog = (await res.json()) as DevCatalog
      writeDiskCache(catalog)
      return catalog
    } catch (err) {
      console.warn(`[@chunky/server] models.dev fetch failed (${(err as Error).message}); metadata will degrade`)
      return {} as DevCatalog
    }
  })()
  return inFlight
}

/**
 * Build a lookup that resolves a model id to its models.dev metadata. Providers
 * pass `hints` (an ordered list of models.dev provider ids to prefer, e.g.
 * ["opencode"] for Zen, ["openai"] for Codex) so an id that appears under
 * several providers picks the most relevant one; otherwise the first match
 * across the whole catalog wins.
 */
async function metaLookup(hints: string[]): Promise<(id: string) => DevModel | undefined> {
  const catalog = await loadModelsDev()
  // Global fallback index: first occurrence of an id across all providers.
  const global = new Map<string, DevModel>()
  for (const provider of Object.values(catalog)) {
    for (const [mid, m] of Object.entries(provider.models ?? {})) {
      if (!global.has(mid)) global.set(mid, m)
    }
  }
  return (id: string): DevModel | undefined => {
    for (const hint of hints) {
      const m = catalog[hint]?.models?.[id]
      if (m) return m
    }
    return global.get(id)
  }
}

/** Turn a list of bare model ids into ModelInfo, enriched from models.dev. */
export async function enrichModels(ids: string[], hints: string[]): Promise<ModelInfo[]> {
  const lookup = await metaLookup(hints)
  return ids.map((id) => {
    const m = lookup(id)
    return {
      id,
      name: m?.name ?? id,
      reasoning: Boolean(m?.reasoning),
      ...(typeof m?.limit?.context === "number" ? { contextLimit: m.limit.context } : {}),
    }
  })
}
