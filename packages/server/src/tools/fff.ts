// fffind + ffgrep — FFF-powered path and content search. Default file search
// for the agent (replaces "bash for rg/find"). See https://github.com/dmtrKovalenko/fff.
import { tool } from "@langchain/core/tools"
import { z } from "zod"
import { buildFffQuery, getFinder, gitAnnotation } from "../fff.ts"

const DEFAULT_FIND_LIMIT = 30
const DEFAULT_GREP_LIMIT = 20
const GREP_MAX_LINE_LENGTH = 500

export const fffindInputShape = {
  pattern: z
    .string()
    .describe(
      "Fuzzy path query (e.g. 'PromptInput', 'src/ config'). Multi-word = AND (narrower). Empty + path lists that tree.",
    ),
  path: z.string().optional().describe("Directory or glob constraint (e.g. 'src/', '**/*.ts')."),
  exclude: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .describe("Paths/globs to exclude (comma/space-separated or array), e.g. 'test/,*.min.js'."),
  limit: z.number().optional().describe(`Max results (default ${DEFAULT_FIND_LIMIT}).`),
}

export const fffind = tool(
  async ({
    pattern,
    path,
    exclude,
    limit,
  }: {
    pattern: string
    path?: string
    exclude?: string | string[]
    limit?: number
  }) => {
    const f = await getFinder()
    const pageSize = Math.max(1, Math.min(limit ?? DEFAULT_FIND_LIMIT, 200))
    const query = buildFffQuery(pattern ?? "", path, exclude)
    const result = f.fileSearch(query, { pageSize })
    if (!result.ok) throw new Error(result.error)

    const { items, scores, totalMatched } = result.value
    if (items.length === 0) return `No files matching "${query || pattern}".`

    // Drop weak scattered fuzzy noise when the top score is poor.
    const top = scores[0]?.total ?? 0
    const weakThreshold = Math.max(40, (pattern?.length ?? 0) * 8)
    const weak = top < weakThreshold
    const shown = weak ? items.slice(0, Math.min(8, pageSize)) : items

    const lines = shown.map((item, i) => {
      const score = scores[i]
      const ann = gitAnnotation(item.gitStatus)
      return score?.exactMatch
        ? `${item.relativePath}${ann}`
        : `${item.relativePath}${ann}`
    })

    let out = lines.join("\n")
    const notices: string[] = []
    if (weak && shown.length > 0) {
      notices.push(
        `Query "${pattern}" produced only weak fuzzy matches. Showing ${shown.length}/${totalMatched}.`,
      )
    } else if (totalMatched > shown.length) {
      notices.push(`${totalMatched - shown.length} more matches not shown (raise limit).`)
    }
    if (notices.length) out += `\n\n[${notices.join(" ")}]`
    return out
  },
  {
    name: "fffind",
    description:
      "Fuzzy path/filename search over the workspace (FFF). Frecency-ranked, git-aware. " +
      "Matches the whole repo-relative path. Use for finding files; use ffgrep for content.",
    schema: z.object(fffindInputShape),
  },
)

export const ffgrepInputShape = {
  pattern: z.string().describe("Search text or regex to find in file contents."),
  path: z.string().optional().describe("Directory/file/glob constraint (e.g. 'src/', '*.ts')."),
  exclude: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .describe("Paths/globs to exclude."),
  caseSensitive: z.boolean().optional().describe("Force case-sensitive match (default: smart-case)."),
  regex: z.boolean().optional().describe("Treat pattern as regex (default: plain/literal)."),
  context: z.number().optional().describe("Context lines before/after each hit (default 0)."),
  limit: z.number().optional().describe(`Max matches (default ${DEFAULT_GREP_LIMIT}).`),
}

export const ffgrep = tool(
  async ({
    pattern,
    path,
    exclude,
    caseSensitive,
    regex,
    context,
    limit,
  }: {
    pattern: string
    path?: string
    exclude?: string | string[]
    caseSensitive?: boolean
    regex?: boolean
    context?: number
    limit?: number
  }) => {
    if (!pattern || !pattern.trim()) throw new Error("pattern is required")
    // Reject pure-wildcard regex that would dump the whole repo.
    if (regex && /^\.\**$/.test(pattern.trim())) {
      throw new Error("Pattern matches everything; use a more specific pattern or fffind for listing files.")
    }

    const f = await getFinder()
    const pageSize = Math.max(1, Math.min(limit ?? DEFAULT_GREP_LIMIT, 200))
    const query = buildFffQuery(pattern, path, exclude)
    const ctx = Math.max(0, Math.min(context ?? 0, 5))

    let result = f.grep(query, {
      mode: regex ? "regex" : "plain",
      smartCase: caseSensitive !== true,
      beforeContext: ctx,
      afterContext: ctx,
      pageSize,
      classifyDefinitions: true,
    })
    if (!result.ok) throw new Error(result.error)

    // Auto-fuzzy fallback on zero exact matches (typo-resistant, like pi-fff).
    if (result.value.items.length === 0 && !regex) {
      const fuzzy = f.grep(query, {
        mode: "fuzzy",
        smartCase: caseSensitive !== true,
        beforeContext: ctx,
        afterContext: ctx,
        pageSize,
        classifyDefinitions: true,
      })
      if (fuzzy.ok && fuzzy.value.items.length > 0) {
        result = fuzzy
      }
    }

    const { items, totalMatched } = result.value
    if (items.length === 0) return `No content matches for "${pattern}".`

    const lines: string[] = []
    for (const m of items) {
      const ann = gitAnnotation((m as { gitStatus?: string }).gitStatus)
      let content = m.lineContent ?? ""
      if (content.length > GREP_MAX_LINE_LENGTH) {
        content = content.slice(0, GREP_MAX_LINE_LENGTH) + "…"
      }
      const def = (m as { isDefinition?: boolean }).isDefinition ? " [def]" : ""
      lines.push(`${m.relativePath}:${m.lineNumber}:${def}${ann} ${content}`)
    }

    let out = lines.join("\n")
    if (totalMatched > items.length) {
      out += `\n\n[${totalMatched - items.length} more matches not shown (raise limit).]`
    }
    return out
  },
  {
    name: "ffgrep",
    description:
      "Content search over the workspace (FFF). Smart-case, plain by default; set regex=true for regex. " +
      "Auto-falls back to fuzzy on zero hits. Prefer this over bash rg/grep.",
    schema: z.object(ffgrepInputShape),
  },
)
