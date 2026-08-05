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

  test("remove handles head, middle, and absent entries while preserving positions", () => {
    const q = new PromptQueue()
    q.enqueue({ id: "head", prompt: "a", shown: "A", kind: "prompt" })
    q.enqueue({ id: "middle", prompt: "b", shown: "B", kind: "prompt" })
    q.enqueue({ id: "tail", prompt: "c", shown: "C", kind: "prompt" })
    expect(q.remove("head")?.prompt).toBe("a")
    expect(q.remove("middle")?.prompt).toBe("b")
    expect(q.remove("missing")).toBeUndefined()
    expect(q.snapshot()).toEqual([expect.objectContaining({ id: "tail", position: 0 })])
  })

  test("promotion claim wins over drain, while a prior drain reports already running", () => {
    const q = new PromptQueue()
    q.enqueue({ id: "promote-first", prompt: "promote", shown: "Promote", kind: "prompt" })
    expect(q.take("promote-first")).toMatchObject({ outcome: "removed", entry: { prompt: "promote" } })
    expect(q.shift()).toBeUndefined()

    q.enqueue({ id: "drain-first", prompt: "drain", shown: "Drain", kind: "prompt" })
    expect(q.shift()?.id).toBe("drain-first")
    expect(q.take("drain-first")).toEqual({ outcome: "drained" })
    expect(q.take("unknown")).toEqual({ outcome: "not-found" })
  })

  test("interjections are FIFO, standalone, preserve images, and can be cleared", () => {
    const b = new InterjectionBuffer()
    const images = [{ id: "img", mediaType: "image/png", byteLength: 3, path: "/tmp/img.png" }]
    expect(images[0]).not.toHaveProperty("base64")
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
