// @chunky/protocol/relay — wire contract for the hosted relay (relay.chunky.to).
// Shared by the relay service (private repo), the computer-side uplink, and
// remote clients (iPhone app / RelayClient). Same rule as index.ts: import
// these shapes, do not fork them. See docs/relay-design.md.

export const DEFAULT_RELAY_URL = "https://relay.chunky.to"
export const RELAY_WS_PATH = "/ws"
export const DEFAULT_RELAY_PORT = 8790

/** Max relay frame size (payload ciphertext included), bytes. */
export const RELAY_MAX_FRAME_BYTES = 4 * 1024 * 1024
/** Store-and-forward buffer caps per target device. The buffer only smooths
 *  short offline gaps — deep history replays from the Chunky server's sqlite
 *  when the client reopens its SSE tunnel. */
export const RELAY_OUTBOX_MAX_FRAMES = 2000
export const RELAY_OUTBOX_MAX_AGE_MS = 24 * 60 * 60 * 1000
/** Pairing codes expire this long after /pair/begin. */
export const RELAY_PAIRING_TTL_MS = 10 * 60 * 1000

export type DeviceKind = "computer" | "phone"

/** A device on the account, as the relay reports it (never includes keys —
 *  peers exchange public keys through the pairing QR, not the relay). */
export interface PeerInfo {
  deviceId: string
  kind: DeviceKind
  name: string
  online: boolean
  /** ms epoch of last connect/disconnect; null = never connected. */
  lastSeen: number | null
}

// ---- WS frames (plaintext TO the relay; `payload` is always opaque E2E ciphertext) ----

/** client -> relay. First frame on a socket MUST be `hello` (within 10s). */
export type RelayClientFrame =
  | { t: "hello"; token: string; lastSeq?: number }
  | { t: "send"; to: string; payload: string }
  | { t: "ack"; seq: number }
  | { t: "ping" }

/** relay -> client. */
export type RelayServerFrame =
  | { t: "hello.ok"; deviceId: string; accountId: string; peers: PeerInfo[] }
  | { t: "recv"; from: string; seq: number; payload: string }
  | { t: "presence"; deviceId: string; online: boolean }
  | { t: "pong" }
  | { t: "error"; code: "auth" | "unknown-peer" | "bad-frame" | "too-large" | "internal"; message: string }

// ---- Tunnel frames (INSIDE the E2E payload — the relay never sees these) ----
// Mirrors HTTP so remote clients speak the existing ROUTES contract unchanged.
// `body`/`data` are base64. Streaming (SSE) responses use start/chunk/end.

export type TunnelFrame =
  | { t: "http.req"; id: string; method: string; path: string; headers?: Record<string, string>; body?: string }
  | { t: "http.res"; id: string; status: number; headers?: Record<string, string>; body?: string }
  | { t: "http.res.start"; id: string; status: number; headers?: Record<string, string> }
  | { t: "http.res.chunk"; id: string; data: string }
  | { t: "http.res.end"; id: string }
  | { t: "http.cancel"; id: string }

// ---- REST (relative to the relay base URL) ----

export const RELAY_ROUTES = {
  // POST AppleAuthRequest -> AuthResponse. Verifies a Sign-in-with-Apple
  // identity token against Apple's JWKS.
  authApple: "/auth/apple",
  // GET ?redirect=<chunky://… | http://localhost…> -> 302 to GitHub authorize.
  authGithubStart: "/auth/github/start",
  // GET ?code&state -> 302 redirect#token=… (or JSON AuthResponse without redirect).
  authGithubCallback: "/auth/github/callback",
  // POST DevAuthRequest -> AuthResponse. Only when RELAY_DEV_AUTH=1.
  authDev: "/auth/dev",
  // POST PairBeginRequest -> PairBeginResponse. Unauthenticated, rate-limited.
  pairBegin: "/pair/begin",
  // POST PairClaimRequest -> PairClaimResponse. Bearer: user session token.
  pairClaim: "/pair/claim",
  // GET -> PairStatusResponse. Bearer: the computer's device token.
  pairStatus: (code: string) => `/pair/${encodeURIComponent(code)}/status`,
  // GET -> AdminPresenceResponse. Bearer: RELAY_ADMIN_TOKEN.
  adminPresence: "/admin/presence",
  health: "/healthz",
} as const

export interface RelayAccount {
  id: string
  provider: "apple" | "github" | "dev"
  email: string | null
}

export interface AppleAuthRequest {
  /** The identityToken JWT from ASAuthorizationAppleIDCredential. */
  identityToken: string
  /** Display name (Apple only provides it on first auth). */
  name?: string
}
export interface DevAuthRequest {
  email: string
}
export interface AuthResponse {
  /** User session token — Bearer for /pair/claim and account endpoints. */
  token: string
  account: RelayAccount
}

export interface PairBeginRequest {
  kind: DeviceKind
  name?: string
}
export interface PairBeginResponse {
  /** Short code embedded in the pairing QR. */
  code: string
  deviceId: string
  /** The computer's device token (WS hello + pairStatus polling). The device
   *  is bound to an account only when a phone claims the code. */
  deviceToken: string
  expiresAt: number
}

export interface PairClaimRequest {
  code: string
  /** sealPairingClaim(...) blob — opaque to the relay. */
  claim: string
  name?: string
}
export interface PairClaimResponse {
  /** The phone's new device id + token on the claiming user's account. */
  deviceId: string
  deviceToken: string
  computer: PeerInfo
}

export type PairStatusResponse =
  | { status: "pending"; expiresAt: number }
  | { status: "claimed"; claim: string; phone: PeerInfo; accountId: string }
  | { status: "expired" }

export interface PresenceAccount {
  accountId: string
  provider: string
  email: string | null
  devices: PeerInfo[]
}
export interface AdminPresenceResponse {
  accounts: PresenceAccount[]
  onlineDevices: number
}
