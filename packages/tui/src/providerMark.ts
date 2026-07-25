const PROVIDER_MARKS: Record<string, string> = {
  anthropic: "A",
  codex: "C",
  grok: "G",
  zen: "Z",
}

// Model ids that read better fully uppercased in the status line.
const MODEL_ACRONYMS = new Set(["glm", "gpt", "api", "llm"])

/** Compact provider identity for dense model labels. */
export function providerMark(provider: string | null | undefined): string {
  if (!provider) return "?"
  return PROVIDER_MARKS[provider.toLowerCase()] ?? provider[0]!.toUpperCase()
}

export function providerModelLabel(
  provider: string | null | undefined,
  model: string,
): string {
  return `${providerMark(provider)}·${model}`
}

/** Prettify a model id for display: `grok-4.5` → `Grok 4.5`, `glm-5.2` → `GLM 5.2`,
 *  `claude-fable-5` → `Claude Fable 5`. Strips any `[...]` variant tag. Best-effort. */
export function prettyModel(id: string | null | undefined): string {
  if (!id) return "…"
  return id
    .replace(/\[.*?\]/g, "")
    .split(/[-_]/)
    .filter(Boolean)
    .map((p) =>
      MODEL_ACRONYMS.has(p.toLowerCase())
        ? p.toUpperCase()
        : /^[\d.]+$/.test(p)
          ? p
          : p[0]!.toUpperCase() + p.slice(1),
    )
    .join(" ")
}

/**
 * Compact executor label for the composer bottom rule / welcome banner.
 * Prefers a provider-reported concrete model (from root `usage.update`) when
 * known; otherwise the configured selection alias. Always provider-qualified.
 */
export function activeExecutorModelLabel(opts: {
  provider: string | null | undefined
  /** Configured selection model id (may be an alias like `opus[1m]`). */
  configuredModel: string | null | undefined
  /** Concrete model id from a root-thread usage.update, when known. */
  resolvedModel?: string | null
  effort?: string | null
}): string | null {
  const id = opts.resolvedModel || opts.configuredModel
  if (!id) return null
  const base = providerModelLabel(opts.provider, prettyModel(id))
  return opts.effort ? `${base} ${opts.effort}` : base
}
