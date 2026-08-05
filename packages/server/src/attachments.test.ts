import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { deleteSessionAttachments, loadAttachmentBase64, saveAttachment } from "./attachments.ts"
import { InterjectionBuffer, PromptQueue } from "./prompt-queue.ts"

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); delete process.env.CHUNKY_SETTINGS })

function state(): string {
  const root = mkdtempSync(join(tmpdir(), "chunky-attachments-")); roots.push(root)
  process.env.CHUNKY_SETTINGS = join(root, "settings.json")
  return root
}

describe("attachments", () => {
  test("save and load round-trip", () => {
    state()
    const ref = saveAttachment("session", Buffer.from("hello").toString("base64"), "image/png")
    expect(ref).toMatchObject({ mediaType: "image/png", byteLength: 5 })
    expect(ref.path.endsWith(".png")).toBe(true)
    expect(loadAttachmentBase64(ref)).toBe(Buffer.from("hello").toString("base64"))
    deleteSessionAttachments("session")
  })

  test("missing files are handled by request builders as unavailable images", async () => {
    state()
    const ref = { id: "missing", mediaType: "image/png", byteLength: 1, path: "/does/not/exist" }
    const { userMessageContent } = await import("./run.ts")
    expect(await userMessageContent("look", [ref])).toEqual([
      { type: "text", text: "look" },
      { type: "text", text: "[Image unavailable: missing]" },
    ])
  })

  test("queued images are refs and never contain base64", () => {
    const ref = { id: "img", mediaType: "image/png", byteLength: 1, path: "/tmp/img" }
    const prompt = new PromptQueue()
    prompt.enqueue({ prompt: "p", shown: "p", kind: "prompt", images: [ref] })
    const interjection = new InterjectionBuffer()
    interjection.push({ id: "i", text: "i", images: [ref] })
    for (const image of [...(prompt.shift()?.images ?? []), ...(interjection.drainAll()[0]?.images ?? [])]) {
      expect(image).toEqual(ref)
      expect(image).not.toHaveProperty("base64")
    }
  })
})
