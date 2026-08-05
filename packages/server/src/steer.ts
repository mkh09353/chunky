import type { AttachmentRef } from "./attachments.ts"
import type { InterjectionBuffer } from "./prompt-queue.ts"

/** A running STEER is an interjection plus a best-effort delegate detach. It
 * never owns or touches the run controller. */
export function steerAtBoundary(
  buffer: InterjectionBuffer,
  note: { id: string; text: string; images?: AttachmentRef[] },
  detachDelegate: () => boolean,
): boolean {
  buffer.push(note)
  return detachDelegate()
}
