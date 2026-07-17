// write — create or overwrite a whole file (jailed to the run's workspace),
// creating parent directories as needed. For surgical changes to an existing
// file, use edit / apply_patch instead; write is for new files or full rewrites.
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { tool } from "@langchain/core/tools"
import { z } from "zod"
import { workspaceFromConfig } from "../workspace.ts"
import { resolveInWorkspace } from "./fs-util.ts"
import { withFileLock } from "../file-lock.ts"

export const writeInputShape = {
  path: z.string().describe("File path (relative or absolute)."),
  content: z.string().describe("Full file contents."),
}

export const write = tool(
  async ({ path, content }: { path: string; content: string }, config?: unknown) => {
    const full = resolveInWorkspace(path, workspaceFromConfig(config))
    await withFileLock(full, () => {
      mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, content, "utf-8")
    })
    return `Wrote ${content.length} bytes to ${path}.`
  },
  {
    name: "write",
    description:
      "Create or overwrite a whole file (parent dirs auto-created). Use only for new files or full rewrites; " +
      "use edit/apply_patch to change an existing file.",
    schema: z.object(writeInputShape),
  },
)
