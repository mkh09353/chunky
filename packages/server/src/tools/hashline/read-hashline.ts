import { readFileSync } from "node:fs"
import { tool } from "@langchain/core/tools"
import { z } from "zod"
import { workspaceFromConfig } from "../../workspace.ts"
import { MAX_BYTES, MAX_LINES, resolveInWorkspace } from "../fs-util.ts"
import { formatAnchor, splitLines } from "./scheme.ts"

export const hashlineReadInputShape = { path: z.string(), offset: z.number().optional(), limit: z.number().optional() }

export const hashlineRead = tool(
  async ({ path, offset = 1, limit = MAX_LINES }: { path: string; offset?: number; limit?: number }, config?: unknown) => {
    const fullPath = resolveInWorkspace(path, workspaceFromConfig(config))
    const lines = splitLines(readFileSync(fullPath, "utf8"))
    const start = Math.max(1, Math.floor(offset))
    const requestedEnd = Math.min(lines.length, start - 1 + Math.min(MAX_LINES, Math.max(0, Math.floor(limit))))
    const rows: string[] = []
    let end = start - 1
    for (let line = start; line <= requestedEnd; line++) {
      const row = `${formatAnchor(line, lines)}→${lines[line - 1]}`
      const bytes = Buffer.byteLength(rows.length ? `${rows.join("\n")}\n${row}` : row)
      if (bytes > MAX_BYTES) break
      rows.push(row)
      end = line
    }
    if (!rows.length && lines.length === 1 && lines[0] === "") return "[File is empty]"
    const hasMore = end < lines.length
    if (hasMore) rows.push(`\n[Showing lines ${start}-${end} of ${lines.length}. Use offset=${end + 1} to continue.]`)
    return rows.join("\n")
  },
  { name: "read", description: `Read a file with absolute 1-based LINE:LOCAL:CHUNK→content anchors (maximum ${MAX_LINES} logical lines and ${MAX_BYTES} bytes). Use offset to page; copy only anchor prefixes before → into edit.`, schema: z.object(hashlineReadInputShape) },
)
