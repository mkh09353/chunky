import { readFileSync, writeFileSync } from "node:fs"
import { tool } from "@langchain/core/tools"
import { z } from "zod"
import { workspaceFromConfig } from "../../workspace.ts"
import { resolveInWorkspace } from "../fs-util.ts"
import { detectLineEnding, normalizeToLF, restoreLineEndings, stripBom } from "../edit-diff.ts"
import { toolResult } from "../result.ts"
import { applyHashline } from "./apply.ts"
import { hashlineEditInputShape, type HashOp } from "./types.ts"

const preprocess = (value: unknown) => {
  if (!value || typeof value !== "object") return value
  const input = { ...(value as Record<string, unknown>) }
  if (typeof input.edits === "string") {
    try { input.edits = JSON.parse(input.edits) } catch { /* zod reports the malformed value */ }
  }
  if (input.edits && !Array.isArray(input.edits)) input.edits = [input.edits]
  return input
}

export const hashlineEdit = tool(
  async ({ path, edits }: { path: string; edits: HashOp[] }, config?: unknown) => {
    const fullPath = resolveInWorkspace(path, workspaceFromConfig(config))
    const raw = readFileSync(fullPath, "utf8")
    const { bom, text } = stripBom(raw)
    const ending = detectLineEnding(text)
    let result
    try { result = applyHashline(normalizeToLF(text), edits) }
    catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught)
      return toolResult(`Hashline edit failed: ${message}`, { ok: false, raw: { kind: "hashline_edit", status: "error", error: "invalid_input", message } })
    }
    if ("error" in result) {
      const detail = result.error!
      return toolResult(`Hashline edit failed: ${detail.message}`, { ok: false, raw: { kind: "hashline_edit", status: "error", detail } })
    }
    writeFileSync(fullPath, bom + restoreLineEndings(result.text, ending), "utf8")
    return toolResult(`Applied ${result.applied} hashline edit(s) to ${path}.\nFresh anchors:\n${result.snippet}${result.warnings.length ? `\nWarnings: ${result.warnings.join(" ")}` : ""}`, {
      raw: { kind: "hashline_edit", status: "ok", applied: result.applied, scheme: "chunk_v1", snippet: result.snippet, snippetStartLine: result.snippetStartLine, snippetRanges: result.snippetRanges, details: result.details, path, warnings: result.warnings },
    })
  },
  {
    name: "edit",
    description: "Edit using fresh LINE:LOCAL:CHUNK anchors from read. Pass only the prefix before → (or ->); strip anchors from replacement content. replace uses inclusive ranges, insert_after inserts after one anchor, and write replaces the whole file. Batches are atomic: after any error, no edits apply and retry the entire batch with fresh anchors.",
    schema: z.preprocess(preprocess, z.object(hashlineEditInputShape)),
  },
)
