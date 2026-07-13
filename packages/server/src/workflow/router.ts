import type { AgentSelectionOverride, ProviderDef } from "../providers/registry.ts"
import { listModelsFor, listProviders } from "../providers/registry.ts"
import type { Effort, WorkflowTargetOverride } from "../settings.ts"
import { normalizeWorkflowTags, workflowTargetKey, workflowTargetOverrides } from "../settings.ts"

export type WorkflowBilling = "subscription" | "free" | "metered" | "unknown"

export interface WorkflowTarget {
  provider: string
  model: string
  name: string
  billing: WorkflowBilling
  tags: string[]
  automatic: boolean
  effort: Effort
  priority: number
  selection: AgentSelectionOverride
}

export interface WorkflowRouteRequest {
  tags?: string[]
  tier?: "small" | "medium" | "big"
}

function isKnownFree(model: string, _name: string): boolean {
  void name
  return /(?:^|[-_.])free$/i.test(model)
}

function providerBilling(
  provider: string,
  model: string,
  name: string,
  declared?: Exclude<WorkflowBilling, "free">,
): WorkflowBilling {
  if (isKnownFree(model, name)) return "free"
  if (declared) return declared
  if (provider === "codex" || provider === "grok" || provider === "anthropic") return "subscription"
  if (provider === "zen") return "metered"
  return "unknown"
}

function defaultsFor(provider: string, model: string, name: string): { tags: string[]; effort: Effort; priority: number } {
  const id = `${model} ${name}`.toLowerCase()
  if (provider === "codex" && id.includes("luna")) {
    return { tags: ["worker", "general", "fast"], effort: "xhigh", priority: 100 }
  }
  if (provider === "grok" && id.includes("grok-4.5")) {
    return { tags: ["worker", "fast", "research"], effort: "high", priority: 95 }
  }
  if (provider === "anthropic" && (id.includes("opus") || id.includes("fable"))) {
    return { tags: ["premium", "frontend", "design"], effort: "high", priority: 90 }
  }
  if (isKnownFree(model, name)) return { tags: ["worker", "general", "free"], effort: "high", priority: 70 }
  return { tags: [], effort: "medium", priority: 10 }
}

export function defaultWorkflowTarget(
  provider: string,
  model: string,
  name: string,
  override: WorkflowTargetOverride = {},
  declaredBilling?: Exclude<WorkflowBilling, "free">,
): WorkflowTarget {
  const billing = providerBilling(provider, model, name, declaredBilling)
  const defaults = defaultsFor(provider, model, name)
  const tags = override.tags === undefined ? defaults.tags : override.tags
  const automatic = override.automatic ?? (billing === "subscription" || billing === "free")
  const effort = override.effort ?? defaults.effort
  return {
    provider,
    model,
    name,
    billing,
    tags,
    automatic,
    effort,
    priority: defaults.priority,
    selection: { provider, model, effort },
  }
}

function requestedTags(request: WorkflowRouteRequest): string[] {
  if (request.tags?.length) return normalizeWorkflowTags(request.tags)
  if (request.tier === "big") return ["premium"]
  if (request.tier === "small") return ["fast"]
  return ["general"]
}

export function chooseWorkflowTarget(targets: WorkflowTarget[], request: WorkflowRouteRequest): WorkflowTarget | null {
  const tags = requestedTags(request)
  const specialist = tags.some((tag) => tag === "frontend" || tag === "design" || tag === "research" || tag === "premium")
  let best: { target: WorkflowTarget; score: number } | undefined
  for (const target of targets) {
    if (!target.automatic) continue
    const matches = tags.filter((tag) => target.tags.includes(tag)).length
    if (specialist && matches === 0) continue
    const score =
      matches * 1000 +
      (target.billing === "subscription" ? 100 : target.billing === "free" ? 80 : 0) +
      target.priority
    if (!best || score > best.score) best = { target, score }
  }
  return best?.target ?? null
}

export async function availableWorkflowTargets(): Promise<WorkflowTarget[]> {
  const overrides = workflowTargetOverrides()
  const ready = listProviders().filter((provider) => provider.ready())
  const groups = await Promise.all(
    ready.map(async (provider: ProviderDef) => {
      try {
        const models = await listModelsFor(provider.id)
        return models.map((model) =>
          defaultWorkflowTarget(
            provider.id,
            model.id,
            model.name,
            overrides[workflowTargetKey(provider.id, model.id)],
            provider.billing,
          ),
        )
      } catch {
        return []
      }
    }),
  )
  return groups.flat()
}

export async function workflowRouteResolver(): Promise<{
  targets: WorkflowTarget[]
  resolve: (request: WorkflowRouteRequest) => AgentSelectionOverride
  validateExplicit: (selection: AgentSelectionOverride) => AgentSelectionOverride
}> {
  const targets = await availableWorkflowTargets()
  const targetsByKey = new Map(targets.map((target) => [workflowTargetKey(target.provider, target.model), target]))
  return {
    targets,
    resolve(request) {
      const target = chooseWorkflowTarget(targets, request)
      if (target) return target.selection
      const tags = requestedTags(request).join(", ")
      throw new Error(
        `WORKFLOW_ROUTING_REQUIRES_USER: No automatic workflow model matches tags [${tags}]. Ask the user which provider/model to use; metered and unknown routes require an explicit opt-in.`,
      )
    },
    validateExplicit(selection) {
      if (!selection.provider || !selection.model) return selection
      const target = targetsByKey.get(workflowTargetKey(selection.provider, selection.model))
      if (!target || !target.automatic) {
        throw new Error(
          `WORKFLOW_ROUTING_REQUIRES_USER: ${selection.provider}/${selection.model} is not allowed for automatic fan-out. Ask the user to approve it with /workers auto ${selection.provider} ${selection.model} on.`,
        )
      }
      return selection
    },
  }
}
