// Agent wiring: ONE model (Zen / GLM-5.2, OpenAI-compatible) driven through a
// DeepAgents agent, with a single trivial custom tool so tool.start/tool.end
// events are exercised.
import { readdirSync } from "node:fs"
import { ChatOpenAI } from "@langchain/openai"
import { MemorySaver } from "@langchain/langgraph"
import { tool } from "@langchain/core/tools"
import { z } from "zod"
import { createDeepAgent } from "deepagents"

function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Missing required env var ${name}`)
  return v
}

// The only provider. Values come from .env via process.env (never hardcoded).
export const model = new ChatOpenAI({
  model: requireEnv("ZEN_MODEL"), // glm-5.2
  apiKey: requireEnv("ZEN_API_KEY"),
  configuration: { baseURL: requireEnv("ZEN_BASE_URL") }, // https://opencode.ai/zen/v1
  streaming: true,
})

// ONE trivial custom tool: list the entries of a directory (defaults to ".").
const listDir = tool(
  async ({ path }: { path?: string }) => {
    const dir = path && path.length > 0 ? path : "."
    try {
      const entries = readdirSync(dir)
      return entries.length ? entries.join("\n") : "(empty directory)"
    } catch (err) {
      return `error: ${(err as Error).message}`
    }
  },
  {
    name: "list_dir",
    description:
      "List the names of files and folders in a directory on the server. Defaults to the current working directory.",
    schema: z.object({
      path: z
        .string()
        .optional()
        .describe("Directory path to list. Defaults to '.' (current directory)."),
    }),
  },
)

// Minimal agent: rely on DeepAgents defaults (in-memory/state filesystem backend),
// add our one tool, and a MemorySaver checkpointer for per-thread state.
export const agent = createDeepAgent({
  model,
  tools: [listDir],
  checkpointer: new MemorySaver(),
})
