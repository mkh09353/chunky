import { tool } from "@langchain/core/tools"
import { z } from "zod"
import { manageModelCatalog } from "../model-catalog.ts"

export const manageModelsInputShape = {
  action: z.enum(["add", "hide", "restore", "list"]).describe("Catalog action. 'hide' is reversible removal from pickers."),
  provider: z.string().describe("Provider id, such as codex, zen, grok, or anthropic."),
  model: z.string().optional().describe("Exact model id. Required except for list."),
}

export const manageModels = tool(
  async ({ action, provider, model }) => JSON.stringify(await manageModelCatalog(action, provider, model), null, 2),
  {
    name: "manage_models",
    description:
      "Manage Chunky's global model catalog when the user explicitly asks. Add custom/new model ids, hide models " +
      "from future pickers without breaking existing sessions, restore hidden models, or list catalog state. " +
      "Changes apply immediately and persist across restarts.",
    schema: z.object(manageModelsInputShape),
  },
)
