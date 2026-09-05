// Codex context mode: for `selection.provider === "codex"` the agents expose the
// Codex history-notes surface (flat notes_*/history_*/new_context names), Codex's
// guidance/reminder/fallback texts, a grace turn before compaction, `[id: …]`
// markers on model-visible tool results and a <context_window> block. Every other
// provider must keep the generic notes/compact_context behavior unchanged.
import { describe, expect, test } from "bun:test"
import { AIMessage, HumanMessage, RemoveMessage, SystemMessage, ToolMessage } from "@langchain/core/messages"
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { tool } from "@langchain/core/tools"
import { createAgent } from "langchain"
import { z } from "zod"
import {
  CODEX_CONTEXT_FALLBACK, CONTEXT_BUDGET_SOURCE, CONTEXT_FALLBACK_SOURCE, COMPACTION_TRIGGER_TOKENS, COMPACTION_WARN_TOKENS,
  chunkyCompactionMiddleware, codexContextBudgetReminder, contextBudgetReminder, contextUsageFor, isCodexContextProvider, pendingCompaction, requestCompaction,
} from "./compaction.ts"
import { CONTEXT_WINDOW_MARKER, codexToolResultMarkerMiddleware, contextToolsFor, executorToolsFor, makePostCompactionReminder, markToolResultsForModel, sidekickToolsFor, toolResultIdMarker } from "./agent.ts"
import { CODEX_CONTEXT_GUIDANCE, SIDEKICK_SYSTEM_PROMPT, buildSystemPrompt, sidekickSystemPrompt } from "./prompt.ts"
import { Store } from "./store.ts"
import { CONTEXT_WINDOW_RECENT_NOTES, formatContextWindowBlock } from "./system-reminder.ts"
import { registerThread, unregisterThread } from "./thread-context.ts"
import { CORE_TOOL_NAMES } from "./tool-search.ts"
import { CODEX_CONTEXT_TOOL_NAMES, codexToolDescriptions, new_context } from "./tools/codex-context.ts"
import { getContextRemainingDescription } from "./tools/context.ts"

const codex = { provider: "codex", model: "gpt-6-astra" } as const
const generic = { provider: "zen", model: "claude-fable-5-1" } as const
const GENERIC_NAMES = ["notes", "compact_context"]
const good = `<summary>${"A useful compacted conversation record. ".repeat(12)}</summary>`
const big = (count: number, prefix = "message", chars = 44_000) => Array.from({ length: count }, (_, i) => new HumanMessage(`${prefix} ${i} ${"x".repeat(chars)}`))
const run = async (provider: string, model: any, messages: any[], runtime: any = {}) => {
  const middleware: any = chunkyCompactionMiddleware({ model, provider })
  return middleware.beforeModel({ messages }, runtime)
}
const session = () => { const id = `codex-mode-${crypto.randomUUID()}`; Store.createSession(id); return id }
const summary = (id: string) => new HumanMessage({ id, content: "summary", additional_kwargs: { lc_source: "summarization" } })
const persistingRuntime = (sessionId: string) => ({ configurable: { thread_id: sessionId, emitSessionEvent: (event: any) => Store.appendEvent(sessionId, event) } })

describe("codex context mode tool lists", () => {
  test("codex lead/child, sidekick and advisor catalogs swap the generic tools for the Codex surface", () => {
    const source = Bun.file(new URL("./agent.ts", import.meta.url)).text()
    for (const names of [executorToolsFor(codex).tools.map((t) => t.name), sidekickToolsFor(codex).map((t) => t.name)]) {
      for (const name of CODEX_CONTEXT_TOOL_NAMES) expect(names).toContain(name)
      for (const name of GENERIC_NAMES) expect(names).not.toContain(name)
      expect(names).toContain("recall")
      expect(names.filter((name) => name === "get_context_remaining")).toHaveLength(1)
    }
    const codexRemaining = executorToolsFor(codex).tools.find((t) => t.name === "get_context_remaining")!
    expect(codexRemaining.description).toBe(codexToolDescriptions.get_context_remaining)
    expect(contextToolsFor("codex").map((t) => t.name as string)).toEqual([...CODEX_CONTEXT_TOOL_NAMES])
    return source.then((text) => {
      const advisor = text.slice(text.indexOf("export function buildAdvisorAgent"), text.indexOf("export function buildReviewAgent"))
      expect(advisor).toContain("...contextToolsFor(selection.provider)")
      expect(advisor).toContain("chunkyCompactionMiddleware({ model, provider: selection.provider })")
      expect(advisor).toContain("codexToolResultMarkerMiddleware()")
    })
  })

  test("every other provider keeps the generic surface and none of the Codex names", () => {
    for (const names of [executorToolsFor(generic).tools.map((t) => t.name), sidekickToolsFor(generic).map((t) => t.name)]) {
      for (const name of [...GENERIC_NAMES, "get_context_remaining", "recall"]) expect(names).toContain(name)
      for (const name of CODEX_CONTEXT_TOOL_NAMES.filter((name) => name !== "get_context_remaining")) expect(names).not.toContain(name)
    }
    expect(executorToolsFor(generic).tools.find((t) => t.name === "get_context_remaining")!.description).toBe(getContextRemainingDescription)
    expect(contextToolsFor("zen").map((t) => t.name as string)).toEqual(["notes", "get_context_remaining", "compact_context"])
    expect(isCodexContextProvider("codex")).toBe(true)
    expect(isCodexContextProvider("zen")).toBe(false)
    expect(isCodexContextProvider(undefined)).toBe(false)
  })

  test("all Codex context names stay eager under native tool search", () => {
    const core: readonly string[] = CORE_TOOL_NAMES
    for (const name of CODEX_CONTEXT_TOOL_NAMES) expect(core).toContain(name)
  })
})

describe("codex context mode prompts", () => {
  test("lead prompt uses Codex's guidance instead of the generic notes bullet", () => {
    const prompt = buildSystemPrompt("apply_patch", false, "/tmp/workspace", { codexContext: true, nativeToolSearch: true })
    expect(prompt).toContain(`\n\nContext windows:\n${CODEX_CONTEXT_GUIDANCE}`)
    expect(prompt).not.toContain("- Persistent notes:")
    expect(prompt).not.toContain("compact_context")
    for (const text of [
      "For tasks that may span context windows, use the `notes_*` tools",
      "Include the window ID and item ID for every relevant user request you are currently solving as well as important actions/tool calls.",
      "Tool results carry an `[id: ...]` marker immediately after their content; user messages do not — locate them with history_list_items role=user.",
      "You can also use the `get_context_remaining` tool to find the remaining token budget for better planning.",
      "call `new_context` to start the next window",
      "If Previous context window id is present in `<context_window>`, it means a context reset occurred and this is a new window.",
      "prefer `history_read_item` directly; when they are missing or uncertain, use `history_list_items`, or `history_search_contents` to locate the item first.",
      "Treat notes and history as internal bookkeeping. Do not mention them in user-facing messages.",
    ]) expect(prompt).toContain(text)
    expect(prompt).not.toContain("absolute paths")
    const plain = buildSystemPrompt("edit", false, "/tmp/workspace")
    expect(plain).toContain("- Persistent notes:")
    expect(plain).not.toContain("Context windows:")
    expect(plain).not.toContain("notes_write_file")
  })

  test("sidekick prompt swaps the notes sentence in codex mode and is otherwise unchanged", () => {
    const codexPrompt = sidekickSystemPrompt(null, "standard", null, { codexContext: true })
    expect(codexPrompt).toContain(`\n\nContext windows:\n${CODEX_CONTEXT_GUIDANCE}`)
    expect(codexPrompt).not.toContain("Persistent notes:")
    expect(codexPrompt).not.toContain("compact_context")
    expect(codexPrompt).toStartWith("You are the hands-on engineer")
    expect(sidekickSystemPrompt(null)).toBe(`${SIDEKICK_SYSTEM_PROMPT}`)
    expect(SIDEKICK_SYSTEM_PROMPT).toContain("Persistent notes:")
    expect(SIDEKICK_SYSTEM_PROMPT).not.toContain("notes_write_file")
  })
})

describe("codex context mode compaction lifecycle", () => {
  test("warning text is Codex's reminder in codex mode and the generic one elsewhere", async () => {
    const model = { invoke: async () => { throw new Error("must not summarize") } }
    for (const [provider, expected] of [["codex", codexContextBudgetReminder], ["zen", contextBudgetReminder]] as const) {
      const threadId = `warn-${provider}-${crypto.randomUUID()}`
      const result: any = await run(provider, model, big(16, "warn", 40_000), { configurable: { thread_id: threadId } })
      const total = contextUsageFor(threadId)!.total
      expect(total).toBeGreaterThanOrEqual(COMPACTION_WARN_TOKENS)
      expect(result.messages).toHaveLength(1)
      expect(result.messages[0].additional_kwargs.lc_source).toBe(CONTEXT_BUDGET_SOURCE)
      expect(result.messages[0].content).toBe(expected(total))
    }
    const codexText = codexContextBudgetReminder(160_000)
    expect(codexText).toStartWith("<context_window_reminder>\nYour current context window is nearly exhausted; only 15000 tokens remain.")
    expect(codexText).toContain("`notes_write_file` or `notes_append_to_file`")
    expect(codexText).toContain("After saving your state, call `new_context` to continue in a fresh context window.\n</context_window_reminder>")
    expect(codexText).not.toContain("functions.")
    expect(codexText).not.toContain("compact_context")
  })

  test("grace turn: at the trigger codex gets the fallback once, then compaction on the next call", async () => {
    let calls = 0
    const model = { invoke: async () => { calls++; return { content: good } } }
    const threadId = `grace-${crypto.randomUUID()}`
    const runtime = { configurable: { thread_id: threadId } }
    const messages: any[] = big(16, "full")
    const first: any = await run("codex", model, messages, runtime)
    expect(calls).toBe(0)
    expect(contextUsageFor(threadId)!.total).toBeGreaterThanOrEqual(COMPACTION_TRIGGER_TOKENS)
    expect(first.messages).toHaveLength(1)
    expect(first.messages[0]).toBeInstanceOf(SystemMessage)
    expect(first.messages[0].additional_kwargs.lc_source).toBe(CONTEXT_FALLBACK_SOURCE)
    expect(first.messages[0].content).toBe(CODEX_CONTEXT_FALLBACK)
    expect(CODEX_CONTEXT_FALLBACK).toStartWith("<context_window_reminder>\nThe current context window is exhausted. Do not continue the task or give a final answer in this window.")
    expect(CODEX_CONTEXT_FALLBACK).toContain("Make exactly one write or append call to `notes_write_file` or `notes_append_to_file` now")
    expect(CODEX_CONTEXT_FALLBACK).toContain("After the notes result returns, call `new_context`; do not use any tools other than `notes_*` and `new_context`.\n</context_window_reminder>")
    // The model ignored the fallback (no new_context): the following call compacts anyway, once.
    messages.push(first.messages[0], new AIMessage("still going"))
    const second: any = await run("codex", model, messages, runtime)
    expect(calls).toBe(1)
    expect(second.messages[0]).toBeInstanceOf(RemoveMessage)
    expect(second.messages.some((m: any) => m.additional_kwargs?.lc_source === CONTEXT_FALLBACK_SOURCE)).toBe(false)
    expect(second.messages.some((m: any) => m.additional_kwargs?.lc_source === CONTEXT_BUDGET_SOURCE)).toBe(false)
    expect(pendingCompaction(threadId)).toBe(false)
  })

  test("grace turn: new_context after the fallback compacts on the next call", async () => {
    let calls = 0
    const model = { invoke: async () => { calls++; return { content: good } } }
    const threadId = `grace-nc-${crypto.randomUUID()}`
    const runtime = { configurable: { thread_id: threadId } }
    const messages: any[] = big(16, "full")
    const first: any = await run("codex", model, messages, runtime)
    expect(first.messages[0].additional_kwargs.lc_source).toBe(CONTEXT_FALLBACK_SOURCE)
    messages.push(first.messages[0])
    await new_context.invoke({}, runtime)
    expect(pendingCompaction(threadId)).toBe(true)
    const second: any = await run("codex", model, messages, runtime)
    expect(calls).toBe(1)
    expect(second.messages[0]).toBeInstanceOf(RemoveMessage)
    expect(pendingCompaction(threadId)).toBe(false)
  })

  test("new_context below the trigger compacts immediately without a fallback", async () => {
    let calls = 0
    const model = { invoke: async () => { calls++; return { content: good } } }
    const threadId = `nc-early-${crypto.randomUUID()}`
    requestCompaction(threadId)
    const result: any = await run("codex", model, big(16, "early", 30_000), { configurable: { thread_id: threadId } })
    expect(calls).toBe(1)
    expect(result.messages[0]).toBeInstanceOf(RemoveMessage)
  })

  test("non-codex providers still compact immediately at the trigger", async () => {
    let calls = 0
    const model = { invoke: async () => { calls++; return { content: good } } }
    const result: any = await run("zen", model, big(16, "full"), { configurable: { thread_id: `zen-${crypto.randomUUID()}` } })
    expect(calls).toBe(1)
    expect(result.messages[0]).toBeInstanceOf(RemoveMessage)
    expect(result.messages.some((m: any) => m.additional_kwargs?.lc_source === CONTEXT_FALLBACK_SOURCE)).toBe(false)
  })
})

describe("codex context mode <context_window> block", () => {
  test("formats Codex's block with optional previous id and up to five notes", () => {
    const notes = Array.from({ length: 7 }, (_, i) => ({ path: `n${i}.md`, lines: i + 1, bytes: 10 * (i + 1) }))
    expect(formatContextWindowBlock({ agentName: "lead", current: 3, previous: 2, notes })).toBe(
      "<context_window>\nAgent name: lead\nFirst context window id: w1\nCurrent context window id: w3\nPrevious context window id: w2\nRecent notes (up to 5, most-recent first):\n" +
      notes.slice(0, CONTEXT_WINDOW_RECENT_NOTES).map((n) => `- ${n.path} (${n.lines} lines, ${n.bytes} UTF-8 bytes)`).join("\n") + "\n</context_window>",
    )
    expect(formatContextWindowBlock({ agentName: "thread-7", current: 1, notes: [] })).toBe(
      "<context_window>\nAgent name: thread-7\nFirst context window id: w1\nCurrent context window id: w1\nRecent notes (up to 5, most-recent first):\nNo notes.\n</context_window>",
    )
  })

  test("post-compaction reminder in codex mode adds the block, keeps live state, and never inlines note text", async () => {
    const sessionId = session()
    Store.putNote(sessionId, sessionId, "checkpoint.md", "SECRET-NOTE-BODY line 1\nline 2")
    const middleware = makePostCompactionReminder({ codexContext: true })
    const result = await middleware({ messages: [new HumanMessage("old"), summary("sum-1")] }, persistingRuntime(sessionId))
    expect(Store.countCompactions(sessionId)).toBe(1)
    expect(result?.messages).toHaveLength(1)
    const message = result!.messages[0] as SystemMessage
    expect(message.additional_kwargs.lc_source).toBe("chunky-system-reminder")
    expect(message.additional_kwargs[CONTEXT_WINDOW_MARKER]).toBe(true)
    const content = String(message.content)
    expect(content).toContain("Older context was summarized into the message above. Read your checkpoint with notes_read_file and recover any missing details with the history_* tools.")
    expect(content).toContain("Agent name: lead\nFirst context window id: w1\nCurrent context window id: w2\nPrevious context window id: w1\nRecent notes (up to 5, most-recent first):\n- checkpoint.md (2 lines, 30 UTF-8 bytes)\n</context_window>")
    expect(content).not.toContain("SECRET-NOTE-BODY")
    expect(content).not.toContain("## Session Notes")
    expect(content).not.toContain("recall")
    expect(await middleware({ messages: [summary("sum-1"), message] }, persistingRuntime(sessionId))).toBeUndefined()
    // A second compaction advances the ids.
    const next = await middleware({ messages: [summary("sum-2")] }, persistingRuntime(sessionId))
    expect(String(next!.messages.at(-1)!.content)).toContain("Current context window id: w3\nPrevious context window id: w2")
  })

  test("generic post-compaction reminder is unchanged: inline notes, recall line, no block", async () => {
    const sessionId = session()
    Store.putNote(sessionId, sessionId, "checkpoint.md", "SECRET-NOTE-BODY")
    const result = await makePostCompactionReminder()({ messages: [summary("sum-1")] }, persistingRuntime(sessionId))
    const content = String(result!.messages[0]!.content)
    expect(content).toContain("SECRET-NOTE-BODY")
    expect(content).toContain("## Session Notes")
    expect(content).toContain("full unabridged transcript remains available via recall")
    expect(content).not.toContain("<context_window>")
    expect((result!.messages[0] as SystemMessage).additional_kwargs[CONTEXT_WINDOW_MARKER]).toBeUndefined()
  })

  test("fresh codex thread gets the block once before its first model call; other providers get nothing", async () => {
    const sessionId = session()
    const sidekickId = `${sessionId}:sidekick`
    registerThread(sidekickId, { sessionId } as any)
    try {
      Store.putNote(sessionId, sidekickId, "brief.md", "x")
      const middleware = makePostCompactionReminder({ notesOnly: true, codexContext: true })
      const result = await middleware({ messages: [new HumanMessage("brief")] }, { configurable: { thread_id: sidekickId } })
      expect(result?.messages).toHaveLength(1)
      const block = result!.messages[0] as SystemMessage
      expect(block.additional_kwargs[CONTEXT_WINDOW_MARKER]).toBe(true)
      expect(String(block.content)).toBe(`<context_window>\nAgent name: ${sidekickId}\nFirst context window id: w1\nCurrent context window id: w1\nRecent notes (up to 5, most-recent first):\n- brief.md (1 lines, 1 UTF-8 bytes)\n</context_window>`)
      expect(await middleware({ messages: [new HumanMessage("brief"), block] }, { configurable: { thread_id: sidekickId } })).toBeUndefined()
      expect(await makePostCompactionReminder()({ messages: [new HumanMessage("brief")] }, { configurable: { thread_id: sidekickId } })).toBeUndefined()
      expect(await middleware({ messages: [new HumanMessage("x")] }, { configurable: {} })).toBeUndefined()
      // A thread joining a session that already compacted starts in the current window.
      Store.appendEvent(sessionId, { type: "context.compacted", sessionId })
      const later = await makePostCompactionReminder({ codexContext: true })({ messages: [new HumanMessage("brief")] }, { configurable: { thread_id: sidekickId } })
      expect(String(later!.messages[0]!.content)).toContain("Current context window id: w2\nRecent notes")
      expect(String(later!.messages[0]!.content)).not.toContain("Previous context window id")
    } finally {
      unregisterThread(sidekickId)
    }
  })
})

/** A tool-calling chat model driven by a script: records every request it receives. */
class ScriptedModel extends BaseChatModel {
  seen: any[][] = []
  constructor(private script: AIMessage[]) { super({}) }
  _llmType() { return "scripted" }
  bindTools() { return this }
  async _generate(messages: any[]) {
    this.seen.push(messages)
    const message = this.script[Math.min(this.seen.length - 1, this.script.length - 1)]!
    return { generations: [{ text: typeof message.content === "string" ? message.content : "", message }] }
  }
}

describe("codex context mode [id: …] markers", () => {
  test("markToolResultsForModel appends the tool call id to string and block content without touching other messages", () => {
    const human = new HumanMessage("hi")
    const text = new ToolMessage({ content: "out", tool_call_id: "call_1", name: "bash", status: "success" })
    const blocks = new ToolMessage({ content: [{ type: "text", text: "a" }], tool_call_id: "call_2", name: "read" })
    const noId = new ToolMessage({ content: "x", tool_call_id: "" })
    const [h, t, b, n] = markToolResultsForModel([human, text, blocks, noId])
    expect(h).toBe(human)
    expect(n).toBe(noId)
    expect(t).toBeInstanceOf(ToolMessage)
    expect(t.content).toBe(`out${toolResultIdMarker("call_1")}`)
    expect(t.content).toEndWith("\n[id: call_1]")
    expect(t.tool_call_id).toBe("call_1")
    expect(t.name).toBe("bash")
    expect(t.status).toBe("success")
    expect(b.content).toEqual([{ type: "text", text: "a" }, { type: "text", text: "\n[id: call_2]" }])
    expect(text.content).toBe("out")
  })

  test("the middleware marks the model request only", async () => {
    const middleware: any = codexToolResultMarkerMiddleware()
    const state = [new HumanMessage("hi"), new ToolMessage({ content: "out", tool_call_id: "call_9", name: "bash" })]
    let seen: any[] = []
    const reply = new AIMessage("done")
    const result = await middleware.wrapModelCall({ messages: state, systemPrompt: "" }, async (request: any) => { seen = request.messages; return reply })
    expect(result).toBe(reply)
    expect(seen[1].content).toBe("out\n[id: call_9]")
    expect(state[1]!.content).toBe("out")
  })

  test("end to end: the model sees the marker, the streamed ToolMessage (persisted as tool.end) does not", async () => {
    const echo = tool(async ({ text }: { text: string }) => `echo:${text}`, { name: "echo", description: "echo", schema: z.object({ text: z.string() }) })
    const model = new ScriptedModel([
      new AIMessage({ content: "", tool_calls: [{ id: "call_e2e", name: "echo", args: { text: "ping" }, type: "tool_call" }] }),
      new AIMessage("final"),
    ])
    const agent = createAgent({ model, tools: [echo], middleware: [codexToolResultMarkerMiddleware()] })
    const streamed: ToolMessage[] = []
    for await (const chunk of await agent.stream({ messages: [new HumanMessage("go")] }, { streamMode: ["updates", "messages"] } as any)) {
      const [mode, payload] = chunk as unknown as [string, any]
      if (mode !== "updates") continue
      for (const update of Object.values(payload) as any[]) for (const m of update?.messages ?? []) if (m?._getType?.() === "tool") streamed.push(m)
    }
    expect(streamed).toHaveLength(1)
    expect(streamed[0]!.content).toBe("echo:ping")
    expect(model.seen).toHaveLength(2)
    const modelVisible = model.seen[1]!.find((m: any) => m._getType?.() === "tool")
    expect(modelVisible.content).toBe("echo:ping\n[id: call_e2e]")
    expect(model.seen[1]!.filter((m: any) => m._getType?.() === "tool")).toHaveLength(1)
  })
})
