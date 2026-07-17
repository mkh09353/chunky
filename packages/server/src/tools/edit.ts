// edit — Pi's multi-edit tool: exact (then fuzzy) text replacement, with multiple
// disjoint edits applied against the ORIGINAL file in one call. Non-GPT/Codex
// models get this instead of apply_patch (see agent.ts's editToolsForModel). The
// matching/replacement core lives in edit-diff.ts (ported from Pi). Errors are
// thrown so the LangChain tool wrapper marks the tool message is_error and the
// model can retry — the same contract as apply-patch.ts.
import { readFileSync, writeFileSync } from "node:fs"
import { tool } from "@langchain/core/tools"
import { z } from "zod"
import { workspaceFromConfig } from "../workspace.ts"
import { resolveInWorkspace } from "./fs-util.ts"
import {
  applyEditsToNormalizedContent,
  detectLineEnding,
  type Edit,
  normalizeToLF,
  restoreLineEndings,
  stripBom,
} from "./edit-diff.ts"
import { toolResult } from "./result.ts"
import { withFileLock } from "../file-lock.ts"

interface EditInput {
  path: string
  edits: Edit[]
  oldText?: unknown
  newText?: unknown
}

/**
 * Coerce loose model output into `{ path, edits[] }`, mirroring Pi's robustness:
 * some models (Opus 4.6, GLM-5.1) send `edits` as a JSON string; older tool
 * shapes send a single top-level `oldText`/`newText`. Run before schema parsing
 * (via z.preprocess) so the model still sees the clean array schema.
 */
function prepareEditArguments(input: unknown): unknown {
  if (!input || typeof input !== "object") return input
  const args = { ...(input as Record<string, unknown>) }

  // edits arriving as a JSON string → parse into an array.
  if (typeof args.edits === "string") {
    try {
      const parsed = JSON.parse(args.edits)
      if (Array.isArray(parsed)) args.edits = parsed
    } catch {
      // leave as-is; schema validation will surface the problem
    }
  }

  // Legacy single-edit shape → fold the top-level oldText/newText into edits[].
  if (typeof args.oldText === "string" && typeof args.newText === "string") {
    const edits = Array.isArray(args.edits) ? [...args.edits] : []
    edits.push({ oldText: args.oldText, newText: args.newText })
    args.edits = edits
    delete args.oldText
    delete args.newText
  }

  return args
}

const editItem = z.object({
  oldText: z.string().describe("Exact text to replace; must be unique in the file."),
  newText: z.string().describe("Replacement text."),
})

export const editInputShape = {
  path: z.string().describe("File path (relative or absolute)."),
  edits: z
    .array(editItem)
    .min(1)
    .describe("One or more replacements, each matched against the original file (not applied incrementally)."),
}

const editSchema = z.preprocess(
  prepareEditArguments,
  z.object(editInputShape),
)

export const editTool = tool(
  async ({ path, edits }: { path: string; edits: Edit[] }, config?: unknown) => {
    const full = resolveInWorkspace(path, workspaceFromConfig(config))
    return await withFileLock(full, () => {
    const rawContent = readFileSync(full, "utf-8")

    // Strip the BOM before matching (the model won't include an invisible BOM in
    // oldText), edit in LF space, then restore the original line ending + BOM.
    const { bom, text: content } = stripBom(rawContent)
    const originalEnding = detectLineEnding(content)
    const normalized = normalizeToLF(content)
    const { newContent, appliedEdits } = applyEditsToNormalizedContent(normalized, edits, path)
    const finalContent = bom + restoreLineEndings(newContent, originalEnding)
    writeFileSync(full, finalContent, "utf-8")

    const maxSnippet = 2_000
    const bounded = appliedEdits.slice(0, 32).map((edit) => ({
      ...edit,
      oldText: edit.oldText.slice(0, maxSnippet),
      newText: edit.newText.slice(0, maxSnippet),
      ...(edit.oldText.length > maxSnippet || edit.newText.length > maxSnippet
        ? { snippetsTruncated: true } : {}),
    }))
    return toolResult(`Successfully replaced ${edits.length} block(s) in ${path}.`, {
      raw: {
        kind: "edit",
        path,
        editCount: edits.length,
        edits: bounded,
        ...(appliedEdits.length > bounded.length ? { editsTruncated: true } : {}),
      },
    })
    })
  },
  {
    name: "edit",
    description:
      "Edit a file by exact text replacement. Each edits[].oldText must match a unique, non-overlapping region of " +
      "the file; merge nearby changes and batch multiple edits into a single call.",
    schema: editSchema,
  },
)
