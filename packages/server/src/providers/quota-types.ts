import type { ProviderQuota } from "@chunky/protocol"

export type CollectedProviderQuota = Omit<ProviderQuota, "provider" | "billing">
