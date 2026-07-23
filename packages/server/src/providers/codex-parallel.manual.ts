// Manual live check: does the Codex backend (incl. Luna responses-lite) accept
// parallel_tool_calls:true and emit multi-call batches?
// Run: bun packages/server/src/providers/codex-parallel.manual.ts [model]
import { codexProvider } from "./codex.ts"
import { tool } from "@langchain/core/tools"
import { z } from "zod"

const model = process.argv[2] ?? "gpt-5.6-luna"
const readFile = tool(async ({ path }) => `contents of ${path}: ok`, {
  name: "read_file",
  description: "Read a file",
  schema: z.object({ path: z.string() }),
})
const runCmd = tool(async ({ command }) => `ran ${command}: ok`, {
  name: "run_cmd",
  description: "Run a shell command",
  schema: z.object({ command: z.string() }),
})

await codexProvider.ensureAuth?.()
const llm = codexProvider.buildModel!({ provider: "codex", model } as any).bindTools?.([readFile, runCmd])
if (!llm) throw new Error("model does not support tools")
const res = await llm.invoke([
  ["system", "PARALLELIZE tool calls aggressively: independent calls emitted in one response run concurrently — issue them all at once."],
  ["user", "Read the files a.txt and b.txt and run `ls`. All three are independent — do them in one go."],
])
console.log("model:", model)
console.log("tool_calls:", JSON.stringify((res as any).tool_calls, null, 2))
console.log("count:", (res as any).tool_calls?.length)
