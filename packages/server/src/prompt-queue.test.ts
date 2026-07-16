import { describe, expect, test } from "bun:test"
import { InterjectionBuffer, PromptQueue, formatInterjection } from "./prompt-queue.ts"

describe("prompt queue", () => {
  test("FIFO snapshots retain stable identity, version, and positions", () => {
    const q = new PromptQueue(2)
    q.enqueue({ id: "first", version: 3, createdAt: 10, prompt: "a", shown: "A", kind: "prompt" })
    q.enqueue({ id: "second", prompt: "b", shown: "B", kind: "interject" })
    expect(q.snapshot()).toEqual([
      { id: "first", version: 3, text: "a", shown: "A", kind: "prompt", position: 0, createdAt: 10 },
      expect.objectContaining({ id: "second", version: 1, text: "b", shown: "B", kind: "interject", position: 1 }),
    ])
    expect(q.shift()?.id).toBe("first")
    expect(q.snapshot()[0]).toMatchObject({ id: "second", position: 0 })
  })

  test("cap rejection is deterministic and does not mutate the queue", () => {
    const q = new PromptQueue(1)
    q.enqueue({ id: "kept", prompt: "a", shown: "A", kind: "prompt" })
    expect(() => q.enqueue({ id: "rejected", prompt: "b", shown: "B", kind: "prompt" })).toThrow("prompt queue is full (1)")
    expect(q.snapshot().map((entry) => entry.id)).toEqual(["kept"])
  })

  test("interjections are FIFO, standalone, preserve images, and can be cleared", () => {
    const b = new InterjectionBuffer()
    const images = [{ base64: "abc", mediaType: "image/png" }]
    b.push({ id: "a", text: "one", images })
    b.push({ id: "b", text: "two" })
    expect(b.drainAll()).toEqual([
      { id: "a", text: "one", images },
      { id: "b", text: "two" },
    ])
    b.push({ id: "c", text: "undelivered" })
    b.clear()
    expect(b.length).toBe(0)
    expect(b.drainAll()).toEqual([])
    expect(formatInterjection("x")).toBe("The user sent a message while you were working:\n<user_query>\nx\n</user_query>")
  })
})
