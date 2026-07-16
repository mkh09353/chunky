import { tool, type StructuredTool } from "@langchain/core/tools"

export interface ToolRunResult {
  promptText: string
  raw?: unknown
  ok: boolean
}

export function toolResult(promptText: string, opts: { raw?: unknown; ok?: boolean } = {}): ToolRunResult {
  const text = String(promptText)
  const result = {
    promptText: text,
    ...(opts.raw !== undefined ? { raw: opts.raw } : {}),
    ok: opts.ok ?? true,
  } as ToolRunResult
  Object.defineProperty(result, "toString", { value: () => text, enumerable: false })
  return result
}

export function isToolRunResult(value: unknown): value is ToolRunResult {
  return !!value && typeof value === "object" &&
    typeof (value as { promptText?: unknown }).promptText === "string" &&
    typeof (value as { ok?: unknown }).ok === "boolean"
}

export function asToolRunResult(value: unknown): ToolRunResult {
  if (isToolRunResult(value)) return value
  if (typeof value === "string") return toolResult(value)
  if (value instanceof Error) return toolResult(value.message, { ok: false })
  if (value == null) return toolResult(String(value))
  try {
    const json = JSON.stringify(value, null, 2)
    return toolResult(json === undefined ? String(value) : json)
  } catch {
    return toolResult(String(value))
  }
}

/** Keep structured data in LangChain's artifact channel; only promptText becomes content. */
export function dualTool(target: StructuredTool): StructuredTool {
  return tool(
    async (args: any, config?: any) => {
      // The outer wrapper owns ToolMessage creation. Passing its toolCall into
      // the inner legacy tool would make LangChain serialize ToolRunResult into
      // model-visible JSON before we can split the two channels.
      const { toolCall: _toolCall, ...innerConfig } = config ?? {}
      const result = asToolRunResult(await target.invoke(args, innerConfig))
      return [result.promptText, result] as any
    },
    {
      name: target.name,
      description: target.description,
      schema: target.schema,
      responseFormat: "content_and_artifact",
    },
  ) as StructuredTool
}
