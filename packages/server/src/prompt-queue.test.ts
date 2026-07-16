import { describe, expect, test } from "bun:test"
import { InterjectionBuffer, PromptQueue, formatInterjection } from "./prompt-queue.ts"
describe("prompt queue", () => {
  test("FIFO snapshots and cap", () => { const q = new PromptQueue(2); q.enqueue({ prompt: "a", shown: "A", kind: "prompt" }); q.enqueue({ prompt: "b", shown: "B", kind: "prompt" }); expect(q.snapshot().map(x => x.position)).toEqual([0, 1]); expect(q.shift()?.prompt).toBe("a"); expect(() => q.enqueue({ prompt: "c", shown: "C", kind: "prompt" })).not.toThrow() })
  test("interjections are FIFO and never merged", () => { const b = new InterjectionBuffer(); b.push({ id: "a", text: "one" }); b.push({ id: "b", text: "two" }); expect(b.drainAll().map(x => x.text)).toEqual(["one", "two"]); expect(formatInterjection("x")).toBe("The user sent a message while you were working:\n<user_query>\nx\n</user_query>") })
})
