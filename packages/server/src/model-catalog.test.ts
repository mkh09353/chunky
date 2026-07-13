import { afterAll, describe, expect, test } from "bun:test"
import { readFileSync, unlinkSync } from "node:fs"

const SETTINGS = `/tmp/chunky-model-catalog-${process.pid}-${Date.now()}.json`
process.env.CHUNKY_SETTINGS = SETTINGS

const settings = await import("./settings.ts")
const { mergeModelCatalog } = await import("./providers/registry.ts")
const { manageModels } = await import("./tools/manage-models.ts")
const { setModelAvailability, getModelAvailability } = await import("./model-catalog.ts")
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

  test("bulk availability is normalized, preserves custom records, and persists once", async () => {
    settings.addCatalogModel("codex", "custom-bulk-model")
    const record = settings.modelCatalogFor("codex").added?.["custom-bulk-model"]
    const before = await getModelAvailability("codex")
    const ids = before.models.map((model: { id: string }) => model.id)
    expect(ids).toContain("custom-bulk-model")
    const keep = ids[0]!
    await setModelAvailability("codex", [keep, keep])
    const overlay = settings.modelCatalogFor("codex")
    expect(overlay.hidden).toEqual(ids.filter((id: string) => id !== keep))
    expect(overlay.added?.["custom-bulk-model"]).toEqual(record)
    const disk = JSON.parse(readFileSync(SETTINGS, "utf8"))
    expect(disk.modelCatalog.codex.hidden).toEqual(overlay.hidden)
  })

  test("bulk validation is atomic", async () => {
    const before = settings.modelCatalogFor("codex")
    await expect(setModelAvailability("codex", ["not a model"])).rejects.toThrow("whitespace")
    expect(settings.modelCatalogFor("codex")).toEqual(before)
  })
})

describe("workflow target overrides", () => {
  test("validates effort values at JSON boundaries", () => {
    expect(settings.isEffort("xhigh")).toBe(true)
    expect(settings.isEffort("expensive")).toBe(false)
  })

  test("stores provider-qualified tags and automatic fan-out permission as optional exceptions", () => {
    settings.setWorkflowTargetOverride("anthropic", "opus[1m]", {
      tags: [" Frontend ", "design", "frontend"],
      automatic: true,
      effort: "high",
    })
    expect(settings.workflowTargetOverrides()["anthropic/opus[1m]"]).toEqual({
      tags: ["frontend", "design"],
      automatic: true,
      effort: "high",
    })
    settings.setWorkflowTargetOverride("anthropic", "opus[1m]", null)
    expect(settings.workflowTargetOverrides()["anthropic/opus[1m]"]).toBeUndefined()
  })
})
