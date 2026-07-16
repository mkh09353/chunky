import { z } from "zod"

export const replaceOp = z.object({ op: z.literal("replace"), anchor: z.string(), end_anchor: z.string().optional(), content: z.string() })
export const insertOp = z.object({ op: z.literal("insert_after"), anchor: z.string(), content: z.string() })
export const writeOp = z.object({ op: z.literal("write"), content: z.string() })
export const hashlineEditInputShape = { path: z.string(), edits: z.array(z.union([replaceOp, insertOp, writeOp])).min(1) }
export type HashOp = z.infer<typeof replaceOp> | z.infer<typeof insertOp> | z.infer<typeof writeOp>
export type HashOps = HashOp[]
export type HashErrorKind = "anchor_stale" | "ambiguous_anchor" | "anchor_not_found" | "overlapping_edits" | "invalid_input"
export interface HashError {
  kind: HashErrorKind
  message: string
  requestedAnchor?: string
  current?: string
  context?: string
  shiftedTo?: number
  shiftedAnchor?: string
  candidates?: number[]
  candidateAnchors?: string[]
}
