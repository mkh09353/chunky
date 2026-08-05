export const MAX_INLINE_IMAGE_BYTES = 12 * 1024 * 1024

type ImageInfo = { mediaType: string; bytes: number }

function imageInfo(block: any): ImageInfo | null {
  if (block?.type === "image_url" && typeof block.image_url?.url === "string") {
    const match = block.image_url.url.match(/^data:([^;,]+)(?:;[^,]*)?;base64,(.*)$/s)
    if (match) return { mediaType: match[1], bytes: Buffer.from(match[2], "base64").byteLength }
  }
  if (block?.type === "image" && block.source?.type === "base64" && typeof block.source.data === "string") {
    return { mediaType: typeof block.source.media_type === "string" ? block.source.media_type : "image", bytes: Buffer.from(block.source.data, "base64").byteLength }
  }
  return null
}

function marker(info: ImageInfo): string {
  return `[Image removed to save context: ${info.mediaType}, ${(info.bytes / 1024).toFixed(1)} KB; the file can be re-read if needed]`
}

function replaceContent(content: any, keep: Set<any>, removed: Set<any>): any {
  if (!Array.isArray(content)) return content
  return content.map((block) => {
    const info = imageInfo(block)
    if (!info) return block
    return keep.has(block) ? block : { type: "text", text: marker(info) }
  })
}

/** Copy messages and replace inline image blocks, retaining newest images first. */
export function stripInlineImages(messages: any[], budget = MAX_INLINE_IMAGE_BYTES): any[] {
  const imageBlocks: Array<{ block: any; info: ImageInfo }> = []
  for (const message of messages) {
    if (!Array.isArray(message?.content)) continue
    for (const block of message.content) {
      const info = imageInfo(block)
      if (info) imageBlocks.push({ block, info })
    }
  }
  const keep = new Set<any>()
  let used = 0
  for (let i = imageBlocks.length - 1; i >= 0; i--) {
    const item = imageBlocks[i]
    if (used + item.info.bytes <= budget) { keep.add(item.block); used += item.info.bytes }
  }
  return messages.map((message) => {
    if (!Array.isArray(message?.content)) return message
    const content = replaceContent(message.content, keep, new Set())
    return content.every((part: any, index: number) => part === message.content[index]) ? message : { ...message, content }
  })
}

