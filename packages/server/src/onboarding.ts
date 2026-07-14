import type { ModeSpec } from "./settings.ts"
import { saveMode, setAdvisor, setSidekick, resetSidekickSeat, setSidekickSeats, setOnboardedAt } from "./settings.ts"
import { getProvider, listModelsFor, setActiveProviderId, setSelection } from "./providers/registry.ts"
import { invalidateAgent } from "./agent.ts"
import { AuthStore } from "./providers/auth-store.ts"
import { saveCustomProviders, loadSettings, type CustomProvider } from "./settings.ts"
export function saveCustomProvider(input: CustomProvider & { key: string }): { id: string; label: string } {
  if (["zen", "codex", "grok", "anthropic"].includes(input.id)) throw new Error("provider id is reserved")
  const { key, ...provider } = input
  saveCustomProviders([...(loadSettings().customProviders ?? []).filter((p) => p.id !== input.id), provider])
  AuthStore.set(input.id, { type: "api", key })
  return { id: input.id, label: input.label }
}

export interface OnboardingSuggestion { name: string; description: string; spec: ModeSpec }
export async function suggestedModes(ready: Set<string>): Promise<OnboardingSuggestion[]> {
  let model = "claude-opus"
  let opus = "claude-opus"
  if (ready.has("anthropic")) {
    try {
      const models = await listModelsFor("anthropic")
      opus = models.find((m) => /opus/i.test(m.id))?.id ?? opus
      model = models.find((m) => /fable/i.test(m.id))?.id ?? opus
    } catch {}
  }
  if (ready.has("codex") && ready.has("anthropic")) return [{ name: "fire", description: "Anthropic Fable leads, with Codex workers and advice (Opus on frontend).", spec: { provider: "anthropic", model, effort: "low", sidekick: { provider: "codex", model: "gpt-5.6-luna", effort: "xhigh" }, advisor: { provider: "codex", model: "gpt-5.6-sol" }, sidekickSeats: { frontend: { provider: "anthropic", model: opus } } } }]
  if (ready.has("codex")) return [{ name: "default", description: "Codex Sol leads with Luna as a high-effort sidekick.", spec: { provider: "codex", model: "gpt-5.6-sol", sidekick: { provider: "codex", model: "gpt-5.6-luna", effort: "xhigh" }, advisor: null } }]
  if (ready.has("anthropic")) return [{ name: "default", description: "Anthropic Fable leads your conversation.", spec: { provider: "anthropic", model, sidekick: null, advisor: null } }]
  return []
}
export function applyOnboardingMode(name: string, spec: ModeSpec): void {
  if (!getProvider(spec.provider)) throw new Error(`unknown provider "${spec.provider}"`)
  saveMode(name, spec); setActiveProviderId(spec.provider); setSelection(spec.provider, { model: spec.model, effort: spec.effort, speed: spec.speed })
  if (spec.advisor) setAdvisor({ enabled: true, provider: spec.advisor.provider, model: spec.advisor.model, effort: spec.advisor.effort }); else setAdvisor({ enabled: false })
  if (spec.sidekick) setSidekick({ enabled: true, provider: spec.sidekick.provider, model: spec.sidekick.model, effort: spec.sidekick.effort }); else resetSidekickSeat()
  if (spec.sidekickSeats) setSidekickSeats(spec.sidekickSeats); else if (spec.sidekickSeats === null) setSidekickSeats({})
  invalidateAgent()
}
