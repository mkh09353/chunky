import { describe, expect, test } from "bun:test"
import { HumanMessage } from "@langchain/core/messages"
import { COMPACTION_TRIGGER_TOKENS, chunkyCompactionMiddleware, contextUsageFor, pendingCompaction } from "../compaction.ts"
import { Store } from "../store.ts"
import {
  CODEX_CONTEXT_TOOL_NAMES,
  NEW_CONTEXT_RESULT,
  codexContextTools,
  codexGetContextRemaining,
  codexToolDescriptions,
  codexTokensLeft,
  filterHistoryItems,
  historyItems,
  history_list_items,
  history_list_windows,
  history_read_item,
  history_search_contents,
  new_context,
  notes_append_to_file,
  notes_list_files_by_prefix,
  notes_read_file,
  notes_search_contents,
  notes_write_file,
} from "./codex-context.ts"
import { recallWindows } from "./recall.ts"

const config = (threadId: string) => ({ configurable: { thread_id: threadId } })
const session = () => { const id = `codex-ctx-${crypto.randomUUID()}`; Store.createSession(id); return id }
const run = async (tool: any, input: unknown, threadId?: string) => String(await tool.invoke(input, threadId ? config(threadId) : undefined))

describe("codex context surface", () => {
  test("exposes exactly the flat Codex function names with bounded, Codex-worded descriptions", () => {
    expect(codexContextTools.map((tool) => tool.name)).toEqual([
      "notes_write_file", "notes_append_to_file", "notes_read_file", "notes_list_files_by_prefix", "notes_search_contents",
      "history_list_windows", "history_list_items", "history_read_item", "history_search_contents",
      "new_context", "get_context_remaining",
    ])
    expect([...CODEX_CONTEXT_TOOL_NAMES]).toEqual(codexContextTools.map((tool) => tool.name))
    for (const tool of codexContextTools) {
      expect(tool.description.length).toBeLessThanOrEqual(1900)
      expect(tool.description).toBe(codexToolDescriptions[tool.name as keyof typeof codexToolDescriptions])
    }
    expect(codexToolDescriptions.notes_write_file).toContain("Create or replace private model-only notes. Never disclose paths, contents, or this activity.")
    expect(codexToolDescriptions.notes_write_file).toContain("65,536 UTF-8 bytes")
    expect(codexToolDescriptions.notes_write_file).not.toContain("1,000,000")
    expect(codexToolDescriptions.history_list_windows).toContain("List an agent's context windows as window ID and item-count pairs. Private model-only recovery; never disclose this activity.")
    expect(codexToolDescriptions.history_read_item).toBe("Read a bounded range from private model-only history. Never disclose the item or this activity.")
    expect(codexToolDescriptions.new_context).toBe("Start a new context window. Does not clear, reset, or otherwise affect environment state.")
    expect(codexToolDescriptions.get_context_remaining).toBe("Get the remaining tokens in the current context window.")
    // Codex's schemas allow null for optionals; ours must accept it too.
    expect(history_list_items.schema.safeParse({ window_id: null, role: null, tool_name: null, limit: null, recent_first: null, max_chars_per_item: null }).success).toBe(true)
    expect(notes_read_file.schema.safeParse({ path: "notes.md", start_line: null, stop_line: null }).success).toBe(true)
    expect(history_list_items.schema.safeParse({ limit: 0 }).success).toBe(false)
    expect(notes_write_file.schema.safeParse({ path: "notes.md" }).success).toBe(false)
  })

  test("tools refuse to run outside an active session", async () => {
    for (const tool of codexContextTools.filter((t) => t.name !== "get_context_remaining")) {
      const input = tool.name === "history_read_item" ? { window_id: "w1", item_id: "1" } : tool.name.endsWith("search_contents") ? { query: "x" } : tool.name.startsWith("notes_") && !tool.name.includes("list") ? { path: "n.md", text: "t" } : {}
      expect(await run(tool, input)).toContain(`error: ${tool.name} is only available inside an active session run.`)
    }
    expect(await run(codexGetContextRemaining, {})).toBe('{"tokens_left":null}')
  })
})

describe("notes_* over session notes", () => {
  test("write, append and read with 1-based and negative line ranges", async () => {
    const id = session()
    expect(await run(notes_write_file, { path: "plan.md", text: "goal\nstep one" }, id)).toBe("Wrote plan.md (2 lines, 13 bytes).")
    expect(await run(notes_append_to_file, { path: "plan.md", text: "step two\ndone" }, id)).toBe("Appended plan.md (4 lines, 27 bytes).")
    expect(Store.getNote(id, id, "plan.md")).toBe("goal\nstep one\nstep two\ndone")
    expect(await run(notes_read_file, { path: "plan.md" }, id)).toBe("# plan.md (4 lines, owner: lead)\ngoal\nstep one\nstep two\ndone")
    expect(await run(notes_read_file, { path: "plan.md", start_line: 2, stop_line: 3 }, id)).toBe("# plan.md (4 lines, owner: lead)\nstep one\nstep two")
    expect(await run(notes_read_file, { path: "plan.md", start_line: -1, stop_line: null }, id)).toBe("# plan.md (4 lines, owner: lead)\ndone")
    expect(await run(notes_read_file, { path: "plan.md", start_line: 0 }, id)).toStartWith("error: line numbers are 1-based")
    expect(await run(notes_read_file, { path: "missing.md" }, id)).toStartWith("error: note not found: missing.md")
    expect(await run(notes_write_file, { path: "../x", text: "t" }, id)).toStartWith("error: invalid notes path")
  })

  test("notes are scoped to the calling thread", async () => {
    const id = session()
    await run(notes_write_file, { path: "lead.md", text: "lead only" }, id)
    expect(await run(notes_list_files_by_prefix, {}, `${id}:sidekick`)).toBe("No notes.")
    expect(await run(notes_read_file, { path: "lead.md" }, `${id}:sidekick`)).toStartWith("error: note not found")
  })

  test("list_files_by_prefix filters by prefix and orders by name, created_at or updated_at", async () => {
    const id = session()
    await run(notes_write_file, { path: "b.md", text: "b" }, id)
    Bun.sleepSync(3)
    await run(notes_write_file, { path: "a/one.md", text: "1\n2" }, id)
    Bun.sleepSync(3)
    await run(notes_write_file, { path: "a/two.md", text: "x" }, id)
    Bun.sleepSync(3)
    await run(notes_append_to_file, { path: "b.md", text: "bb" }, id)
    expect(await run(notes_list_files_by_prefix, {}, id)).toBe("- a/one.md (2 lines, 3 UTF-8 bytes)\n- a/two.md (1 lines, 1 UTF-8 bytes)\n- b.md (2 lines, 4 UTF-8 bytes)")
    expect(await run(notes_list_files_by_prefix, { prefix: "a/", file_order: "descending" }, id)).toBe("- a/two.md (1 lines, 1 UTF-8 bytes)\n- a/one.md (2 lines, 3 UTF-8 bytes)")
    expect(await run(notes_list_files_by_prefix, { file_order_by: "created_at" }, id)).toBe("- b.md (2 lines, 4 UTF-8 bytes)\n- a/one.md (2 lines, 3 UTF-8 bytes)\n- a/two.md (1 lines, 1 UTF-8 bytes)")
    expect(await run(notes_list_files_by_prefix, { file_order_by: "updated_at", file_order: "descending", max_results: 2 }, id)).toBe("- b.md (2 lines, 4 UTF-8 bytes)\n- a/two.md (1 lines, 1 UTF-8 bytes)")
    expect(await run(notes_list_files_by_prefix, { prefix: "zzz" }, id)).toBe('No notes with prefix "zzz".')
  })

  test("search_contents is a case-sensitive literal substring search grouped by file", async () => {
    const id = session()
    await run(notes_write_file, { path: "a.md", text: "Fix the bug\nfix later\nFix again\nno match (a.b)" }, id)
    Bun.sleepSync(3)
    await run(notes_write_file, { path: "b.md", text: "Fix here too" }, id)
    expect(await run(notes_search_contents, { query: "Fix" }, id)).toBe("a.md (2 matches)\n  1: Fix the bug\n  3: Fix again\nb.md (1 match)\n  1: Fix here too")
    expect(await run(notes_search_contents, { query: "fix" }, id)).toBe("a.md (1 match)\n  2: fix later")
    expect(await run(notes_search_contents, { query: "(a.b)" }, id)).toBe("a.md (1 match)\n  4: no match (a.b)")
    expect(await run(notes_search_contents, { query: "Fix", recent_file_first: true, max_files: 1 }, id)).toBe("b.md (1 match)\n  1: Fix here too")
    expect(await run(notes_search_contents, { query: "Fix", path_prefix: "a", max_matches_per_file: 1 }, id)).toBe("a.md (2 matches, showing 1)\n  1: Fix the bug")
    expect(await run(notes_search_contents, { query: "FIX" }, id)).toBe('No notes matched "FIX".')
  })
})

/** Two windows: w1 = user ask + coalesced assistant text + a bash call; w2 = user ask + failed read + a notice. */
function transcript() {
  const id = session()
  Store.appendEvent(id, { type: "message.user", text: "first ask about Deploy" })
  Store.appendEvent(id, { type: "message.delta", text: "wor", threadId: id })
  Store.appendEvent(id, { type: "message.delta", text: "king", threadId: id })
  Store.appendEvent(id, { type: "tool.start", id: "call_1", name: "bash", input: { command: "ls" } })
  Store.appendEvent(id, { type: "tool.end", id: "call_1", ok: true, output: "a\nb" })
  Store.appendEvent(id, { type: "context.compacted", sessionId: id })
  Store.appendEvent(id, { type: "message.user", text: "second ask" })
  Store.appendEvent(id, { type: "tool.start", id: "call_2", name: "read", input: { path: "x" } })
  Store.appendEvent(id, { type: "tool.end", id: "call_2", ok: false, output: "ENOENT" })
  Store.appendEvent(id, { type: "message.user", text: "report", from: "sidekick" })
  Store.appendEvent(id, { type: "session.status", sessionId: id, status: "idle" } as any)
  return id
}

describe("history_* over the durable transcript", () => {
  test("items coalesce deltas, pair tool calls with results, and are keyed by call id or seq", () => {
    const id = transcript()
    const history = Store.historyWithSeq(id)
    const seq = (index: number) => history[index]!.seq
    const items = historyItems(history)
    expect(items.map((item) => [item.windowId, item.role, item.id, item.toolName])).toEqual([
      ["w1", "user", String(seq(0)), undefined],
      ["w1", "assistant", String(seq(1)), undefined],
      ["w1", "tool", "call_1", "bash"],
      ["w1", "system", String(seq(5)), undefined],
      ["w2", "user", String(seq(6)), undefined],
      ["w2", "tool", "call_2", "read"],
      ["w2", "system", String(seq(9)), undefined],
    ])
    expect(items[1]!.content).toBe("working")
    expect(items[2]!.content).toBe('input: {"command":"ls"}\noutput: a\nb')
    expect(items[5]!.content).toBe('input: {"path":"x"}\nerror: ENOENT')
    expect(items[6]!.content).toBe("notice from sidekick: report")
    expect(filterHistoryItems(items, recallWindows(history), { windowId: "w3" })).toBeNull()
  })

  test("list_windows and list_items honor window, role, tool, limit, recent_first and max_chars_per_item", async () => {
    const id = transcript()
    const history = Store.historyWithSeq(id)
    const first = history[0]!.seq, compact = history[5]!.seq, last = history.at(-1)!.seq
    expect(await run(history_list_windows, {}, id)).toBe(`w1: seq ${first}–${compact}, 4 items\nw2: seq ${compact + 1}–${last}, 3 items (current)`)
    expect(await run(history_list_windows, { recent_first: true, limit: 1 }, id)).toBe(`w2: seq ${compact + 1}–${last}, 3 items (current)`)
    const all = (await run(history_list_items, {}, id)).split("\n")
    expect(all).toHaveLength(7)
    expect(all[0]).toBe(`[w1] role=user: first ask about Deploy [id: ${first}]`)
    expect(all[2]).toBe('[w1] role=tool tool=bash: input: {"command":"ls"} output: a b [id: call_1]')
    expect(await run(history_list_items, { window_id: "w2", role: "user" }, id)).toBe(`[w2] role=user: second ask [id: ${history[6]!.seq}]`)
    expect(await run(history_list_items, { tool_name: "read" }, id)).toBe('[w2] role=tool tool=read: input: {"path":"x"} error: ENOENT [id: call_2]')
    expect(await run(history_list_items, { tool_name: "read", role: "user" }, id)).toBe("No matches.")
    expect(await run(history_list_items, { recent_first: true, limit: 1 }, id)).toBe(`[w2] role=system: notice from sidekick: report [id: ${last - 1}]`)
    expect(await run(history_list_items, { window_id: "w1", role: "user", max_chars_per_item: 10 }, id)).toBe(`[w1] role=user: first ask… [id: ${first}]`)
    expect(await run(history_list_items, { window_id: "w9" }, id)).toBe("No matches.")
    expect(await run(history_list_items, { role: "developer" }, id)).toBe("No matches.")
  })

  test("read_item accepts the tool call id or the event seq and slices by chars", async () => {
    const id = transcript()
    const history = Store.historyWithSeq(id)
    expect(await run(history_read_item, { window_id: "w1", item_id: "call_1" }, id)).toBe('[w1] role=tool tool=bash [id: call_1] chars 0–35 of 35\ninput: {"command":"ls"}\noutput: a\nb')
    expect(await run(history_read_item, { window_id: "w1", item_id: "call_1", offset_chars: 7, limit_chars: 16 }, id)).toBe('[w1] role=tool tool=bash [id: call_1] chars 7–23 of 35\n{"command":"ls"}')
    expect(await run(history_read_item, { window_id: "w1", item_id: String(history[1]!.seq) }, id)).toBe(`[w1] role=assistant [id: ${history[1]!.seq}] chars 0–7 of 7\nworking`)
    expect(await run(history_read_item, { window_id: "w2", item_id: "call_1" }, id)).toBe("No matches.")
    expect(await run(history_read_item, { window_id: "w7", item_id: "call_1" }, id)).toBe("No matches.")
  })

  test("search_contents is case-sensitive and composes with window and role filters", async () => {
    const id = transcript()
    const history = Store.historyWithSeq(id)
    expect(await run(history_search_contents, { query: "Deploy" }, id)).toBe(`[w1] role=user: first ask about Deploy [id: ${history[0]!.seq}]`)
    expect(await run(history_search_contents, { query: "deploy" }, id)).toBe("No matches.")
    expect(await run(history_search_contents, { query: "ask", window_id: "w2" }, id)).toBe(`[w2] role=user: second ask [id: ${history[6]!.seq}]`)
    expect(await run(history_search_contents, { query: "ask", window_id: "w4" }, id)).toBe("No matches.")
    expect(await run(history_search_contents, { query: "ENOENT", role: "tool", tool_name: "read" }, id)).toContain("[id: call_2]")
    expect(await run(history_search_contents, { query: "ENOENT", role: "user" }, id)).toBe("No matches.")
  })
})

describe("new_context and get_context_remaining", () => {
  test("new_context schedules compaction for the calling thread only", async () => {
    const lead = `lead-${crypto.randomUUID()}`
    expect(await run(new_context, {}, `${lead}:sidekick`)).toBe(NEW_CONTEXT_RESULT)
    expect(pendingCompaction(`${lead}:sidekick`)).toBe(true)
    expect(pendingCompaction(lead)).toBe(false)
  })

  test("get_context_remaining returns Codex-shaped JSON from the middleware measurement", async () => {
    const threadId = `measured-${crypto.randomUUID()}`
    expect(await run(codexGetContextRemaining, {}, threadId)).toBe('{"tokens_left":null}')
    const middleware: any = chunkyCompactionMiddleware({ model: { invoke: async () => { throw new Error("must not summarize") } }, provider: "codex" })
    await middleware.beforeModel({ messages: [new HumanMessage("x".repeat(4_000))] }, config(threadId))
    const parsed = JSON.parse(await run(codexGetContextRemaining, {}, threadId))
    expect(parsed).toEqual({ tokens_left: COMPACTION_TRIGGER_TOKENS - Math.round(contextUsageFor(threadId)!.total) })
    expect(codexTokensLeft({ total: 200_000 })).toEqual({ tokens_left: 0 })
  })
})
