import { describe, expect, test } from "bun:test"
import { MAX_INLINE_IMAGE_BYTES, stripInlineImages } from "./inline-images.ts"

const open = (data: string, mediaType = "image/png") => ({ type: "image_url", image_url: { url: `data:${mediaType};base64,${data}` } })
const anthropic = (data: string, mediaType = "image/jpeg") => ({ type: "image", source: { type: "base64", media_type: mediaType, data } })

describe("inline image stripping", () => {
  test("passes under-budget images byte-identically", () => {
    const messages = [{ role: "user", content: [{ type: "text", text: "look" }, open("aGVsbG8=")] }]
    const result = stripInlineImages(messages)
    expect(result[0]!.content).toEqual(messages[0]!.content)
    expect(result[0]!.content[1]).toBe(messages[0]!.content[1])
  })

  test("removes oldest OpenAI and Anthropic images first", () => {
    const oldOpen = open(Buffer.from("old").toString("base64"))
    const oldAnthropic = anthropic(Buffer.from("older").toString("base64"))
    const newest = open(Buffer.from("new").toString("base64"))
    const result = stripInlineImages([
      { content: [oldOpen] },
      { content: [oldAnthropic] },
      { content: [newest] },
    ], 5)
    expect(result[0]!.content[0].text).toContain("image/png")
    expect(result[1]!.content[0].text).toContain("image/jpeg")
    expect(result[2]!.content[0]).toEqual(newest)
    expect(result[0]!.content[0].text).not.toContain("b2xk")
  })

  test("preserves mixed text and image content", () => {
    const image = open("aGVsbG8=")
    const result = stripInlineImages([{ content: [{ type: "text", text: "before" }, image, { type: "text", text: "after" }] }], 0)
    expect(result[0]!.content[0]).toEqual({ type: "text", text: "before" })
    expect(result[0]!.content[2]).toEqual({ type: "text", text: "after" })
    expect(result[0]!.content[1].text).toContain("Image removed")
  })

  test("uses the declared budget", () => {
    expect(MAX_INLINE_IMAGE_BYTES).toBe(12 * 1024 * 1024)
  })
})
