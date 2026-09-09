// Shared provider sign-in failure marker. Runners throw this once they have
// already emitted the actionable `error` event so callers don't emit a second
// generic bubble for the same failure.

/** Matches Anthropic/Claude Code auth failures in SDK error text or
 *  `SDKAssistantMessageError` codes. Network, quota, and model errors must
 *  NOT match: those never mean the sign-in is unusable. The token clause is
 *  deliberately narrow — a loose `invalid.*token` would also match
 *  `invalid_request_error: prompt is too long: … tokens`. */
export const PROVIDER_AUTH_FAILURE_PATTERN =
  /authentication_failed|oauth_org_not_allowed|OAuth (?:session|token)(?: has| is)? expired|not logged in|Login expired|invalid(?:[ _-](?:access|oauth|auth|refresh|bearer))?[ _-]token|token (?:is|was) (?:invalid|revoked|expired)|\b401\b|Failed to authenticate/i

export function isProviderAuthFailure(text: string | undefined | null): boolean {
  return typeof text === "string" && PROVIDER_AUTH_FAILURE_PATTERN.test(text)
}

export class ProviderAuthError extends Error {
  readonly code = "provider-auth" as const
  readonly provider: string
  /** True once the actionable `error` event for this failure has been emitted. */
  readonly emitted: boolean
  constructor(provider: string, detail: string, options: { emitted?: boolean; cause?: unknown } = {}) {
    super(detail, options.cause !== undefined ? { cause: options.cause } : undefined)
    this.name = "ProviderAuthError"
    this.provider = provider
    this.emitted = options.emitted ?? false
  }
}

/** True when an error was already surfaced as a provider-auth `error` event. */
export function isReportedProviderAuthError(error: unknown): error is ProviderAuthError {
  return error instanceof ProviderAuthError && error.emitted
}

/** Short user-facing provider name for auth error bubbles. */
export function providerAuthLabel(provider: string, fallbackLabel?: string): string {
  if (provider === "anthropic") return "Claude"
  return fallbackLabel ?? provider
}
