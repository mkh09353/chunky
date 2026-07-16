import { describe, expect, test } from "bun:test"
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages"
import {
  interruptedToolCallRecovery,
  streamWithCheckpointRecovery,
} from "./checkpoint-recovery.ts"

describe("interrupted tool-call checkpoint recovery", () => {
  test("leaves a complete parallel tool-call batch unchanged", () => {
    const messages = [
      new AIMessage({
        id: "assistant-1",
        content: "",
        tool_calls: [
          { id: "call-1", name: "read", args: {}, type: "tool_call" },
          { id: "call-2", name: "bash", args: {}, type: "tool_call" },
        ],
      }),
      new ToolMessage({ id: "result-1", tool_call_id: "call-1", content: "one" }),
      new ToolMessage({ id: "result-2", tool_call_id: "call-2", content: "two" }),
    ]

    expect(interruptedToolCallRecovery(messages)).toEqual({
      removeMessageIds: [],
      interruptedCallIds: [],
    })
  })

  test("removes an incomplete assistant batch and its partial outputs", () => {
    const messages = [
      new HumanMessage({ id: "prompt-1", content: "do the work" }),
      new AIMessage({
        id: "assistant-1",
        content: "starting",
        tool_calls: [
          { id: "call-1", name: "read", args: {}, type: "tool_call" },
          { id: "call-2", name: "bash", args: {}, type: "tool_call" },
        ],
      }),
      new ToolMessage({ id: "result-1", tool_call_id: "call-1", content: "one" }),
      new HumanMessage({ id: "prompt-2", content: "continue" }),
    ]

    expect(interruptedToolCallRecovery(messages)).toEqual({
      removeMessageIds: ["assistant-1", "result-1"],
      interruptedCallIds: ["call-1", "call-2"],
    })
  })

  test("removes a tool output whose assistant call is already absent", () => {
    const messages = [
      new HumanMessage({ id: "prompt-1", content: "do the work" }),
      new ToolMessage({ id: "orphan-result", tool_call_id: "missing-call", content: "late" }),
      new HumanMessage({ id: "prompt-2", content: "continue" }),
    ]

    expect(interruptedToolCallRecovery(messages)).toEqual({
      removeMessageIds: ["orphan-result"],
      interruptedCallIds: ["missing-call"],
    })
  })

  test("repairs an output persisted after a newer user message", () => {
    const messages = [
      new AIMessage({
        id: "assistant-1",
        content: "",
        tool_calls: [{ id: "call-1", name: "read", args: {}, type: "tool_call" }],
      }),
      new HumanMessage({ id: "prompt-1", content: "continue" }),
      new ToolMessage({ id: "late-result", tool_call_id: "call-1", content: "late" }),
    ]

    expect(interruptedToolCallRecovery(messages)).toEqual({
      removeMessageIds: ["assistant-1", "late-result"],
      interruptedCallIds: ["call-1"],
    })
  })

  test("repairs persisted state before submitting the next user message", async () => {
    const calls: string[] = []
    const agent = {
      async getState() {
        calls.push("getState")
        return {
          values: {
            messages: [
              new AIMessage({
                id: "assistant-1",
                content: "",
                tool_calls: [{ id: "call-1", name: "read", args: {}, type: "tool_call" }],
              }),
            ],
          },
        }
      },
      async updateState(_config: unknown, update: { messages: Array<{ id: string }> }) {
        calls.push(`updateState:${update.messages.map((message) => message.id).join(",")}`)
      },
      async stream() {
        calls.push("stream")
        return "stream-result"
      },
    }

    const result = await streamWithCheckpointRecovery(
      agent,
      { messages: [{ role: "user", content: "continue" }] },
      { configurable: { thread_id: "thread-1" } },
    )

    expect(result).toBe("stream-result")
    expect(calls).toEqual(["getState", "updateState:assistant-1", "stream"])
  })
})
