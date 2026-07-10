// read — return a file's RAW text with NO line-number gutter. Dropping the
// `cat -n` gutter is the single biggest per-read token win: the model reads the
// same bytes it will later paste back into an `edit`/`apply_patch` oldText, so
// there is nothing to strip. Reads default to the first 2000 lines / 50KB (head);
// offset/limit page through larger files. All paths are jailed to WORKSPACE.
import { readFileSync } from "node:fs"
import { tool } from "@langchain/core/tools"
import { z } from "zod"
import { MAX_BYTES, MAX_LINES, resolveInWorkspace, truncateOutput } from "./fs-util.ts"

export const readInputShape = {
  path: z.string().describe("File path (relative or absolute)."),
  offset: z.number().optional().describe("1-indexed start line."),
  limit: z.number().optional().describe("Max lines to read."),
}

export const read = tool(
  async ({ path, offset, limit }: { path: string; offset?: number; limit?: number }) => {
    const full = resolveInWorkspace(path)
    const text = readFileSync(full, "utf-8")
    if (text.length === 0) return "[File is empty]"

    const allLines = text.split("\n")
    const totalLines = allLines.length
    const startLine = offset && offset > 0 ? offset - 1 : 0
    const startDisplay = startLine + 1
    if (startLine >= allLines.length) {
      throw new Error(`offset ${offset} is beyond end of file (${totalLines} lines total)`)
    }

    const endLine = limit !== undefined ? Math.min(startLine + limit, allLines.length) : allLines.length
    const selected = allLines.slice(startLine, endLine).join("\n")

    const { content, truncated } = truncateOutput(selected, { keep: "head" })
    const outputLines = content === "" ? 0 : content.split("\n").length
    const endDisplay = startDisplay + outputLines - 1
    const showedThrough = startLine + outputLines // 0-indexed exclusive end shown

    // Footer only when there is more to read: either the 2000/50KB cap fired, or a
    // user-supplied limit stopped before EOF.
    if (truncated || showedThrough < allLines.length) {
      return `${content}\n\n[Showing lines ${startDisplay}-${endDisplay} of ${totalLines}. Use offset=${endDisplay + 1} to continue.]`
    }
    return content
  },
  {
    name: "read",
    description: `Read a file's raw text (no line-number gutter). Capped at the first ${MAX_LINES} lines / ${MAX_BYTES / 1000}KB; use offset/limit to page through larger files.`,
    schema: z.object(readInputShape),
  },
)
