import { randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { stateDir } from "./repos.ts"

export interface AttachmentRef { id: string; mediaType: string; byteLength: number; path: string }

function extensionFor(mediaType: string): string {
  const subtype = mediaType.toLowerCase().split("/")[1]?.split(";")[0]
  return subtype && /^[a-z0-9]+$/.test(subtype) ? `.${subtype}` : ".bin"
}

export function saveAttachment(sessionId: string, base64: string, mediaType: string): AttachmentRef {
  const id = randomUUID()
  const dir = join(stateDir(), "attachments", sessionId)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${id}${extensionFor(mediaType)}`)
  const bytes = Buffer.from(base64, "base64")
  writeFileSync(path, bytes)
  return { id, mediaType, byteLength: bytes.byteLength, path }
}

export function loadAttachmentBase64(ref: AttachmentRef): string { return readFileSync(ref.path).toString("base64") }

export function deleteSessionAttachments(sessionId: string): void {
  try { rmSync(join(stateDir(), "attachments", sessionId), { recursive: true, force: true }) } catch { /* best effort */ }
}
