import { tool } from "@langchain/core/tools"
import { z } from "zod"
import { getAppZooEndpoint } from "../app-zoo.ts"
import { toolResult } from "./result.ts"

const UNAVAILABLE = "The Chunky desktop app isn't running — ask the user to open the app."
const timeout = 10_000

function fail(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return toolResult(`Zoo service request failed: ${message}`, { ok: false })
}

/** Call the authenticated loopback service hosted by the desktop app. */
export async function callZoo(method: string, params: unknown) {
  const endpoint = getAppZooEndpoint()
  if (!endpoint) return toolResult(UNAVAILABLE, { ok: false })
  try {
    const response = await fetch(`http://127.0.0.1:${endpoint.port}/zoo/op`, {
      method: "POST",
      headers: { Authorization: `Bearer ${endpoint.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ method, params }),
      signal: AbortSignal.timeout(timeout),
    })
    const body = await response.json().catch(() => null)
    if (!body || typeof body !== "object") return toolResult(`Zoo service returned invalid JSON (${response.status})`, { ok: false })
    return toolResult(JSON.stringify(body), { ok: (body as { ok?: unknown }).ok === true })
  } catch (error) {
    return fail(error)
  }
}

const board = tool(() => callZoo("board", {}), { name: "zoo_board", description: "Read the user's product-factory board (sources → insights → ideas → items), including counts and ideas/items grouped by pipeline state.", schema: z.object({}) })
const search = tool(({ query }: { query: string }) => callZoo("search", { query }), { name: "zoo_search", description: "Search the user's product-factory board across source artifacts, insights, and ideas.", schema: z.object({ query: z.string() }) })
const getIdea = tool(({ ideaId }: { ideaId: string }) => callZoo("getIdea", { ideaId }), { name: "zoo_get_idea", description: "Read a product-factory idea with its cited insights and evidence quotes.", schema: z.object({ ideaId: z.string() }) })
const getItem = tool(({ itemId }: { itemId: string }) => callZoo("getItem", { itemId }), { name: "zoo_get_item", description: "Read a product-factory pipeline item, its originating idea, and decision log.", schema: z.object({ itemId: z.string() }) })
const stages = z.enum(["research", "decision", "building", "review", "shipped", "dropped"])
const moveItem = tool(({ itemId, stage, reason }: { itemId: string; stage: z.infer<typeof stages>; reason: string }) => callZoo("moveItem", { itemId, stage, reason }), { name: "zoo_move_item", description: "Move a product-factory item to a pipeline stage. This mutation is logged as an agent decision with the given concise reason.", schema: z.object({ itemId: z.string(), stage: stages, reason: z.string() }) })
const promoteIdea = tool(({ ideaId, reason }: { ideaId: string; reason: string }) => callZoo("promoteIdea", { ideaId, reason }), { name: "zoo_promote_idea", description: "Promote a product-factory idea into a research-stage item without starting a session. This mutation is logged as an agent decision with the given concise reason.", schema: z.object({ ideaId: z.string(), reason: z.string() }) })
const dismissIdea = tool(({ ideaId, reason }: { ideaId: string; reason: string }) => callZoo("dismissIdea", { ideaId, reason }), { name: "zoo_dismiss_idea", description: "Dismiss a product-factory idea. This mutation is logged as an agent decision with the given concise reason.", schema: z.object({ ideaId: z.string(), reason: z.string() }) })
const ideaTypes = z.enum(["close", "investigate", "build", "needs-detail"])
const createIdea = tool(({ type, title, rationale, insightIds }: { type: z.infer<typeof ideaTypes>; title: string; rationale: string; insightIds?: string[] }) => callZoo("createIdea", { type, title, rationale, ...(insightIds ? { insightIds } : {}) }), { name: "zoo_create_idea", description: "Create a proposed idea on the user's product-factory board, optionally citing insights. This mutation is logged as an agent decision with the given rationale.", schema: z.object({ type: ideaTypes, title: z.string(), rationale: z.string(), insightIds: z.array(z.string()).optional() }) })
const addNote = tool(({ itemId, note }: { itemId: string; note: string }) => callZoo("addNote", { itemId, note }), { name: "zoo_add_note", description: "Add a concise agent decision note to a product-factory item.", schema: z.object({ itemId: z.string(), note: z.string() }) })

export const zooTools = [board, search, getIdea, getItem, moveItem, promoteIdea, dismissIdea, createIdea, addNote]
