const PROVIDER_MARKS: Record<string, string> = {
  anthropic: "A",
  codex: "C",
  grok: "G",
  zen: "Z",
}

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
