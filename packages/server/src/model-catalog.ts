import {
  addCatalogModel,
  hideCatalogModel,
  modelCatalogFor,
  restoreCatalogModel,
} from "./settings.ts"
import { getProvider, listModelsFor } from "./providers/registry.ts"

export type ModelCatalogAction = "add" | "hide" | "restore" | "list"

function requireProvider(provider: string): void {
  if (!getProvider(provider)) throw new Error(`unknown provider "${provider}"`)
}

function requireModel(model: string | undefined): string {
  const id = model?.trim()
  if (!id) throw new Error("model id is required")
  if (/\s/.test(id)) throw new Error("model id cannot contain whitespace")
  return id
}

/** Shared mutation path for HTTP, TUI, and the agent tool. */
export async function manageModelCatalog(
  action: ModelCatalogAction,
  provider: string,
  model?: string,
) {
  requireProvider(provider)
  if (action === "list") {
    const overlay = modelCatalogFor(provider)
    const visible = await listModelsFor(provider)
    return { action, provider, visible, hidden: overlay.hidden ?? [], added: overlay.added ?? {} }
  }

  const id = requireModel(model)
  if (action === "hide") {
    hideCatalogModel(provider, id)
    return { action, provider, model: id, hidden: true }
  }
  if (action === "restore") {
    restoreCatalogModel(provider, id)
    return { action, provider, model: id, hidden: false }
  }

  // If the provider already advertises this id, adding simply restores it and
  // records it as verified. Discovery failures never block an explicit add.
  let verified = false
  try {
    verified = (await getProvider(provider)!.listModels()).some((candidate) => candidate.id === id)
  } catch {
    // Save as unverified; the user explicitly asked for permissive additions.
  }
  addCatalogModel(provider, id, verified)
  return { action, provider, model: id, verified, hidden: false }
}
