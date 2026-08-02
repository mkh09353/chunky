// Manual live check: does the Codex backend accept compaction_trigger, return
// an opaque compaction item, and replay it as replacement history?
// Run: bun packages/server/src/providers/codex-compaction.manual.ts [model]
import { CODEX_API_ENDPOINT, codexProvider, codexRequestHeaders } from "./codex.ts"

type OutputItem = Record<string, any>
type ProbeResult = {
  status: number
  completed: boolean
  itemTypes: string[]
  compaction?: OutputItem
  outputText: string
}

const model = process.argv[2] ?? "gpt-5.6-sol"
const fact = "the deploy password is xyzzy-4242"

function requestBody(input: any[], includeTrigger: boolean): Record<string, any> {
  return {
    model,
    instructions: "Answer briefly and accurately.",
    input: includeTrigger ? [...input, { type: "compaction_trigger" }] : input,
    stream: true,
    store: false,
    include: ["reasoning.encrypted_content"],
  }
}

function printFailure(status: number, text: string): void {
  console.log(`HTTP ${status}: ${text.slice(0, 2000)}`)
}

async function readSse(response: Response): Promise<ProbeResult> {
  const itemTypes: string[] = []
  let compaction: OutputItem | undefined
  let outputText = ""
  let completed = false
  const decoder = new TextDecoder()
  let pending = ""

  const consume = (block: string) => {
    const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n")
    if (!data || data === "[DONE]") return
    let event: any
    try { event = JSON.parse(data) } catch { return }
    if (event.type === "response.completed") completed = true
    if (event.type === "response.output_text.delta") outputText += typeof event.delta === "string" ? event.delta : ""
    if (event.type === "response.output_item.done" && event.item) {
      const item = event.item as OutputItem
      if (typeof item.type === "string") itemTypes.push(item.type)
      if ((item.type === "compaction" || item.type === "compaction_summary") && typeof item.encrypted_content === "string" && item.encrypted_content.length) compaction = item
    }
    // Some Responses implementations include the final output only on the
    // completed event rather than emitting output_item.done for every item.
    for (const item of event.response?.output ?? []) {
      if (typeof item?.type === "string" && !itemTypes.includes(item.type)) itemTypes.push(item.type)
      if ((item?.type === "compaction" || item?.type === "compaction_summary") && typeof item.encrypted_content === "string" && item.encrypted_content.length) compaction = item
    }
  }

  if (response.body) {
    for await (const chunk of response.body) {
      pending += decoder.decode(chunk, { stream: true })
      const blocks = pending.split(/\r?\n\r?\n/)
      pending = blocks.pop() ?? ""
      blocks.forEach(consume)
    }
  }
  pending += decoder.decode()
  if (pending.trim()) consume(pending)
  return { status: response.status, completed, itemTypes, compaction, outputText }
}

async function post(input: any[], includeTrigger: boolean, beta: boolean): Promise<ProbeResult> {
  const headers = await codexRequestHeaders()
  headers.set("accept", "text/event-stream")
  headers.set("content-type", "application/json")
  if (beta) {
    headers.set("OpenAI-Beta", "responses=experimental")
    headers.set("x-codex-beta-features", "remote_compaction_v2")
  }
  const response = await fetch(CODEX_API_ENDPOINT, {
    method: "POST",
    headers,
    body: JSON.stringify(requestBody(input, includeTrigger)),
  })
  if (!response.ok) {
    const text = await response.text()
    printFailure(response.status, text)
    return { status: response.status, completed: false, itemTypes: [], outputText: "" }
  }
  return readSse(response)
}

await codexProvider.ensureAuth?.()
const history = [
  { type: "message", role: "user", content: [{ type: "input_text", text: `Remember this fact: ${fact}` }] },
  { type: "message", role: "assistant", content: [{ type: "output_text", text: "I will remember that fact." }] },
  { type: "message", role: "user", content: [{ type: "input_text", text: "Please prepare to answer a later question." }] },
]

console.log("model:", model)
console.log("trying headers: none")
let betaUsed = false
let result = await post(history, true, false)
if (!result.compaction) {
  betaUsed = true
  console.log("no usable compaction item; retrying with remote-compaction beta headers")
  result = await post(history, true, true)
}

const compaction = result.compaction
console.log("status:", result.status)
console.log("stream completed:", result.completed)
console.log("output item types:", result.itemTypes.length ? result.itemTypes.join(", ") : "(none)")
console.log("compaction item:", compaction ? "yes" : "no")
if (compaction) console.log("encrypted_content length:", compaction.encrypted_content.length)

let replaySuccess = false
if (compaction) {
  console.log("replaying opaque compaction item")
  const replay = await post([compaction, { type: "message", role: "user", content: [{ type: "input_text", text: "what is the deploy password?" }] }], false, betaUsed)
  replaySuccess = replay.outputText.includes("xyzzy-4242")
  console.log("replay status:", replay.status)
  console.log("replay stream completed:", replay.completed)
  console.log("replay output_text recalls password:", replaySuccess)
}

console.log("\n=== remote compaction verdict ===")
console.log("contract accepted:", result.status >= 200 && result.status < 300 && result.completed && !!compaction ? "yes" : "no")
console.log("headers:", betaUsed ? "OpenAI-Beta + x-codex-beta-features" : "none")
console.log("compaction item present:", compaction ? "yes" : "no")
console.log("replay recall success:", replaySuccess ? "yes" : "no")
