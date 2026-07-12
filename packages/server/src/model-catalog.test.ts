import { afterAll, describe, expect, test } from "bun:test"
import { unlinkSync } from "node:fs"

const SETTINGS = `/tmp/chunky-model-catalog-${process.pid}-${Date.now()}.json`
process.env.CHUNKY_SETTINGS = SETTINGS

const settings = await import("./settings.ts")
const { mergeModelCatalog } = await import("./providers/registry.ts")
const { manageModels } = await import("./tools/manage-models.ts")
const { executorToolsFor } = await import("./agent.ts")

afterAll(() => {
  try { unlinkSync(SETTINGS) } catch {}
})

describe("model catalog overlay", () => {
  test("adds, hides, and restores reversibly", () => {
    settings.addCatalogModel("codex", "gpt-5.6-luna")
    expect(settings.modelCatalogFor("codex").added?.["gpt-5.6-luna"]?.verified).toBe(false)

    settings.hideCatalogModel("codex", "gpt-5.6-luna")
    expect(settings.modelCatalogFor("codex").hidden).toContain("gpt-5.6-luna")

    settings.restoreCatalogModel("codex", "gpt-5.6-luna")
    expect(settings.modelCatalogFor("codex").hidden).not.toContain("gpt-5.6-luna")
    expect(settings.modelCatalogFor("codex").added?.["gpt-5.6-luna"]).toBeDefined()
  })

  test("merges custom ids and filters hidden advertised ids", () => {
    const result = mergeModelCatalog(
      [{ id: "gpt-5.6-sol", name: "Sol", reasoning: true }],
      [{ id: "gpt-5.6-luna", name: "Luna", reasoning: true }],
      {
        added: { "gpt-5.6-luna": { verified: false, addedAt: 1 } },
        hidden: ["gpt-5.6-sol"],
      },
    )
    expect(result).toEqual([
      { id: "gpt-5.6-luna", name: "Luna", reasoning: true, custom: true, verified: false },
    ])
  })

  test("the executor exposes the same catalog mutation to the model", async () => {
    const names = executorToolsFor({ provider: "codex", model: "gpt-5.5" }).tools.map((item) => item.name)
    expect(names).toContain("manage_models")

    const output = String(await manageModels.invoke({ action: "hide", provider: "codex", model: "gpt-5.6-luna" }))
    expect(JSON.parse(output)).toMatchObject({ action: "hide", provider: "codex", model: "gpt-5.6-luna" })
    expect(settings.modelCatalogFor("codex").hidden).toContain("gpt-5.6-luna")
  })
})
