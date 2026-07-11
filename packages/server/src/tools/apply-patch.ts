// apply_patch — the V4A diff tool OpenAI's GPT/Codex models are trained on
// (see the Codex CLI's `apply_patch` tool). Claude and other models use the
// Pi-ported `edit` tool instead (see tools/edit.ts); this tool exists so
// gpt/codex models can use the format they actually know.
//
// Envelope:
//   *** Begin Patch
//   *** Update File: relative/path.ext
//   *** Move to: relative/new-path.ext        (optional, Update only)
//   @@ optional context header
//    unchanged context line (leading space)
//   -removed line
//   +added line
//   *** Add File: relative/new.ext
//   +line 1
//   *** Delete File: relative/old.ext
//   *** End Patch
//
// All paths are resolved against the run's workspace and may not escape it (no
// `..`, no absolute paths). The whole patch is validated and computed fully
// in-memory before anything is written to disk — either every file in the
// patch applies cleanly, or nothing is written (no partial/corrupted edits).
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, relative, resolve } from "node:path"
import { tool } from "@langchain/core/tools"
import { z } from "zod"
import { LAUNCH_WORKSPACE, workspaceFromConfig } from "../workspace.ts"

const BEGIN = "*** Begin Patch"
const END = "*** End Patch"
const UPDATE_PREFIX = "*** Update File: "
const ADD_PREFIX = "*** Add File: "
const DELETE_PREFIX = "*** Delete File: "
const MOVE_PREFIX = "*** Move to: "

interface Hunk {
  oldLines: string[]
  newLines: string[]
}

interface UpdateOp {
  kind: "update"
  path: string
  moveTo?: string
  hunks: Hunk[]
}
interface AddOp {
  kind: "add"
  path: string
  content: string
}
interface DeleteOp {
  kind: "delete"
  path: string
}
type PatchOp = UpdateOp | AddOp | DeleteOp

class PatchError extends Error {}

/** Resolve a patch-relative path against `workspace`, rejecting any escape. */
function resolveInWorkspace(relPath: string, workspace: string): string {
  const p = relPath.trim()
  if (!p) throw new PatchError("empty path in patch")
  if (isAbsolute(p)) throw new PatchError(`absolute paths are not allowed: ${p}`)
  const full = resolve(workspace, p)
  const rel = relative(workspace, full)
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new PatchError(`path escapes the workspace: ${p}`)
  }
  return full
}

/** Split an Update File body into hunks. `@@` lines start a new hunk (and may
 *  carry a section-header comment, which we ignore for matching purposes);
 *  a hunk also implicitly starts at the top of the body if it begins with
 *  ' '/'-'/'+' lines directly. */
function splitHunks(bodyLines: string[]): Hunk[] {
  const hunks: Hunk[] = []
  let cur: Hunk | null = null
  const ensure = () => {
    if (!cur) {
      cur = { oldLines: [], newLines: [] }
      hunks.push(cur)
    }
    return cur
  }
  for (const line of bodyLines) {
    if (line.startsWith("@@")) {
      cur = { oldLines: [], newLines: [] }
      hunks.push(cur)
      continue
    }
    if (line.startsWith("\\ ")) continue // "\ No newline at end of file" etc — ignore
    const h = ensure()
    if (line.startsWith(" ")) {
      const text = line.slice(1)
      h.oldLines.push(text)
      h.newLines.push(text)
    } else if (line.startsWith("-")) {
      h.oldLines.push(line.slice(1))
    } else if (line.startsWith("+")) {
      h.newLines.push(line.slice(1))
    } else if (line === "") {
      h.oldLines.push("")
      h.newLines.push("")
    } else {
      // Defensive: an unprefixed line inside a hunk body is treated as context.
      h.oldLines.push(line)
      h.newLines.push(line)
    }
  }
  return hunks.filter((h) => h.oldLines.length > 0 || h.newLines.length > 0)
}

/** Parse the full V4A envelope into an ordered list of file operations. */
function parsePatch(patch: string): PatchOp[] {
  const rawLines = patch.replace(/\r\n/g, "\n").split("\n")
  // Trim a single leading/trailing blank line from copy-paste noise.
  while (rawLines.length && rawLines[0].trim() === "") rawLines.shift()
  while (rawLines.length && rawLines[rawLines.length - 1].trim() === "") rawLines.pop()

  if (rawLines.length === 0 || rawLines[0].trim() !== BEGIN) {
    throw new PatchError(`patch must start with "${BEGIN}"`)
  }
  if (rawLines[rawLines.length - 1].trim() !== END) {
    throw new PatchError(`patch must end with "${END}"`)
  }
  const lines = rawLines.slice(1, -1)

  const ops: PatchOp[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (line.startsWith(UPDATE_PREFIX)) {
      const path = line.slice(UPDATE_PREFIX.length).trim()
      i++
      let moveTo: string | undefined
      if (i < lines.length && lines[i].startsWith(MOVE_PREFIX)) {
        moveTo = lines[i].slice(MOVE_PREFIX.length).trim()
        i++
      }
      const body: string[] = []
      while (i < lines.length && !isSectionStart(lines[i])) {
        body.push(lines[i])
        i++
      }
      const hunks = splitHunks(body)
      if (hunks.length === 0) throw new PatchError(`Update File "${path}" has no hunks`)
      ops.push({ kind: "update", path, moveTo, hunks })
      continue
    }
    if (line.startsWith(ADD_PREFIX)) {
      const path = line.slice(ADD_PREFIX.length).trim()
      i++
      const body: string[] = []
      while (i < lines.length && !isSectionStart(lines[i])) {
        body.push(lines[i])
        i++
      }
      const content = body
        .filter((l) => l.length > 0)
        .map((l) => (l.startsWith("+") ? l.slice(1) : l))
        .join("\n")
      ops.push({ kind: "add", path, content: content.length ? content + "\n" : "" })
      continue
    }
    if (line.startsWith(DELETE_PREFIX)) {
      const path = line.slice(DELETE_PREFIX.length).trim()
      i++
      ops.push({ kind: "delete", path })
      continue
    }
    if (line.trim() === "") {
      i++
      continue
    }
    throw new PatchError(`unrecognized patch line: "${line}"`)
  }
  if (ops.length === 0) throw new PatchError("patch contains no file operations")
  return ops
}

function isSectionStart(line: string): boolean {
  return (
    line.startsWith(UPDATE_PREFIX) ||
    line.startsWith(ADD_PREFIX) ||
    line.startsWith(DELETE_PREFIX)
  )
}

/** Find `needle` (a contiguous run of lines) inside `haystack`, searching from
 *  `from` first (the common case — hunks apply top-to-bottom) and falling
 *  back to a full-file search so out-of-order/context-shifted hunks still
 *  match. Returns -1 if not found. */
function findSubsequence(haystack: string[], needle: string[], from: number): number {
  const tryFrom = (start: number): number => {
    for (let i = Math.max(0, start); i <= haystack.length - needle.length; i++) {
      let ok = true
      for (let j = 0; j < needle.length; j++) {
        if (haystack[i + j] !== needle[j]) {
          ok = false
          break
        }
      }
      if (ok) return i
    }
    return -1
  }
  const direct = tryFrom(from)
  if (direct !== -1) return direct
  return tryFrom(0)
}

function applyUpdate(op: UpdateOp, original: string): string {
  const hadTrailingNewline = original.endsWith("\n")
  const lines = original.length === 0 ? [] : original.split("\n")
  if (hadTrailingNewline) lines.pop() // don't treat the final "" as a real line

  let cursor = 0
  for (const hunk of op.hunks) {
    if (hunk.oldLines.length === 0) {
      // Pure insertion (no context/removed lines) — insert at the current cursor.
      lines.splice(cursor, 0, ...hunk.newLines)
      cursor += hunk.newLines.length
      continue
    }
    const idx = findSubsequence(lines, hunk.oldLines, cursor)
    if (idx === -1) {
      throw new PatchError(
        `hunk did not match in "${op.path}":\n${hunk.oldLines.map((l) => `  ${l}`).join("\n")}`,
      )
    }
    lines.splice(idx, hunk.oldLines.length, ...hunk.newLines)
    cursor = idx + hunk.newLines.length
  }

  return lines.join("\n") + (hadTrailingNewline || lines.length === 0 ? "\n" : "")
}

export interface ApplyPatchOutcome {
  summary: string
  changed: string[]
}

/** Apply a parsed+validated patch, computing every file's new content
 *  in-memory first so a single bad hunk aborts the whole patch before any
 *  write hits disk. */
export function applyPatchText(patch: string, workspace: string = LAUNCH_WORKSPACE): ApplyPatchOutcome {
  const ops = parsePatch(patch)

  const writes: Array<{ path: string; content: string }> = []
  const deletes: string[] = []
  const renames: Array<{ from: string; to: string }> = []
  const changed: string[] = []

  for (const op of ops) {
    if (op.kind === "add") {
      const full = resolveInWorkspace(op.path, workspace)
      if (existsSync(full)) throw new PatchError(`Add File "${op.path}" already exists`)
      writes.push({ path: full, content: op.content })
      changed.push(`add ${op.path}`)
    } else if (op.kind === "delete") {
      const full = resolveInWorkspace(op.path, workspace)
      if (!existsSync(full)) throw new PatchError(`Delete File "${op.path}" does not exist`)
      deletes.push(full)
      changed.push(`delete ${op.path}`)
    } else {
      const full = resolveInWorkspace(op.path, workspace)
      if (!existsSync(full)) throw new PatchError(`Update File "${op.path}" does not exist`)
      const original = readFileSync(full, "utf8")
      const next = applyUpdate(op, original)
      if (op.moveTo) {
        const dest = resolveInWorkspace(op.moveTo, workspace)
        deletes.push(full)
        writes.push({ path: dest, content: next })
        renames.push({ from: op.path, to: op.moveTo })
        changed.push(`update+move ${op.path} -> ${op.moveTo}`)
      } else {
        writes.push({ path: full, content: next })
        changed.push(`update ${op.path}`)
      }
    }
  }

  // Everything validated and computed — now actually touch disk.
  for (const w of writes) {
    mkdirSync(dirname(w.path), { recursive: true })
    writeFileSync(w.path, w.content, "utf8")
  }
  for (const d of deletes) {
    rmSync(d, { force: true })
  }

  return { summary: changed.join("\n"), changed }
}

export const applyPatch = tool(
  async ({ patch }: { patch: string }, config?: unknown) => {
    const { summary, changed } = applyPatchText(patch, workspaceFromConfig(config))
    return `Applied patch (${changed.length} file${changed.length === 1 ? "" : "s"} changed):\n${summary}`
  },
  {
    name: "apply_patch",
    description:
      "Apply a code change using the V4A patch format (the OpenAI/Codex apply_patch envelope): " +
      "`*** Begin Patch` / `*** Update File: path` (with context/`-`/`+` hunks, optionally followed by " +
      "`*** Move to: newpath`) / `*** Add File: path` (with `+` lines) / `*** Delete File: path` / `*** End Patch`. " +
      "Paths are relative to the project root. The whole patch is applied atomically: if any hunk fails to " +
      "match, no files are changed and an error is returned so you can retry with corrected context.",
    schema: z.object({
      patch: z.string().describe("The full patch text in V4A format, including the Begin/End Patch envelope."),
    }),
  },
)
