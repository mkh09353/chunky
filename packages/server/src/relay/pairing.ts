// Reusable one-shot computer pairing state for the CLI and authenticated local
// desktop API. Secrets remain private to this module until the claim validates.
import { hostname } from "node:os";
import {
  DEFAULT_RELAY_URL,
  RELAY_ROUTES,
  type PairBeginResponse,
  type PairStatusResponse,
} from "@chunky/protocol/relay";
import {
  encodePairingQR,
  generateDeviceKeyPair,
  newPairingSecret,
  openPairingClaim,
  toB64,
} from "@chunky/protocol/relay-crypto";
import type {
  RelayBeginPairingResponse,
  RelayPollPairingResponse,
  RelayStatusResponse,
} from "@chunky/protocol";
import {
  loadRelayConfig,
  saveRelayConfig,
  type RelayConfig,
} from "./config.ts";

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isPairBeginResponse(value: unknown): value is PairBeginResponse {
  if (!value || typeof value !== "object") return false;
  const response = value as Record<string, unknown>;
  return isNonEmptyString(response.code)
    && isNonEmptyString(response.deviceId)
    && isNonEmptyString(response.deviceToken)
    && typeof response.expiresAt === "number"
    && Number.isFinite(response.expiresAt);
}

function isPairStatusResponse(value: unknown): value is PairStatusResponse {
  if (!value || typeof value !== "object") return false;
  const response = value as Record<string, unknown>;
  if (response.status === "expired") return true;
  if (response.status === "pending") {
    return typeof response.expiresAt === "number" && Number.isFinite(response.expiresAt);
  }
  if (response.status !== "claimed" || !isNonEmptyString(response.claim) || !isNonEmptyString(response.accountId)) return false;
  const phone = response.phone;
  return !!phone
    && typeof phone === "object"
    && isNonEmptyString((phone as Record<string, unknown>).deviceId)
    && isNonEmptyString((phone as Record<string, unknown>).name);
}

interface PendingPairing {
  relayUrl: string;
  name: string;
  begin: PairBeginResponse;
  secret: Uint8Array;
  publicKey: Uint8Array;
  secretKey: Uint8Array;
  /** Retained server-side so reopening Settings receives byte-identical QR data. */
  response: RelayBeginPairingResponse;
}

export function relayStatus(): RelayStatusResponse {
  const config = loadRelayConfig();
  if (!config)
    return { paired: false, enabled: process.env.CHUNKY_RELAY !== "0" };
  return {
    paired: true,
    enabled: process.env.CHUNKY_RELAY !== "0",
    relayUrl: config.url,
    peers: config.peers.map(({ deviceId, name }) => ({ deviceId, name })),
  };
}

export class RelayPairing {
  private pending: PendingPairing | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  async begin(
    name = hostname(),
    allowExisting = false,
  ): Promise<RelayBeginPairingResponse> {
    if (loadRelayConfig() && !allowExisting)
      throw new Error(
        "already paired; refusing to replace the existing pairing",
      );
    if (this.pending) {
      if (this.now() <= this.pending.begin.expiresAt + 60_000) return this.pending.response;
      this.pending = null;
    }
    const relayUrl = (
      process.env.CHUNKY_RELAY_URL || DEFAULT_RELAY_URL
    ).replace(/\/+$/, "");
    let response: Response;
    try {
      response = await fetch(relayUrl + RELAY_ROUTES.pairBegin, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "computer", name }),
      });
    } catch {
      throw new Error("could not reach relay");
    }
    if (!response.ok) throw new Error(`pair/begin failed (${response.status})`);
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new Error("relay returned an invalid pairing response");
    }
    if (!isPairBeginResponse(value)) throw new Error("relay returned an invalid pairing response");
    const begin = value;
    const keys = generateDeviceKeyPair();
    const secret = newPairingSecret();
    const result: RelayBeginPairingResponse = {
      qrPayload: encodePairingQR({
        v: 1,
        relay: relayUrl,
        code: begin.code,
        computerPubKey: toB64(keys.publicKey),
        secret: toB64(secret),
        name,
      }),
      relayUrl,
      name,
      expiresAt: begin.expiresAt,
    };
    this.pending = {
      relayUrl,
      name,
      begin,
      secret,
      publicKey: keys.publicKey,
      secretKey: keys.secretKey,
      response: result,
    };
    return result;
  }

  async poll(): Promise<{
    result: RelayPollPairingResponse;
    config?: RelayConfig;
  }> {
    const pending = this.pending;
    if (!pending)
      return { result: { status: "error", error: "no pairing in progress" } };
    if (this.now() > pending.begin.expiresAt + 60_000) {
      this.pending = null;
      return { result: { status: "expired" } };
    }
    let response: Response;
    try {
      response = await fetch(
        pending.relayUrl + RELAY_ROUTES.pairStatus(pending.begin.code),
        {
          headers: { authorization: `Bearer ${pending.begin.deviceToken}` },
        },
      );
    } catch {
      return { result: { status: "error", error: "could not reach relay" } };
    }
    if (!response.ok)
      return {
        result: {
          status: "error",
          error: `pair/status failed (${response.status})`,
        },
      };
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      return { result: { status: "error", error: "relay returned an invalid pairing response" } };
    }
    if (!isPairStatusResponse(value)) {
      return { result: { status: "error", error: "relay returned an invalid pairing response" } };
    }
    const status = value;
    if (status.status === "pending")
      return { result: { status: "pending", expiresAt: status.expiresAt } };
    if (status.status === "expired") {
      this.pending = null;
      return { result: { status: "expired" } };
    }
    try {
      const claim = openPairingClaim(status.claim, pending.secret);
      const config: RelayConfig = {
        url: pending.relayUrl,
        deviceId: pending.begin.deviceId,
        deviceToken: pending.begin.deviceToken,
        publicKey: toB64(pending.publicKey),
        secretKey: toB64(pending.secretKey),
        peers: [
          {
            deviceId: status.phone.deviceId,
            name: claim.name ?? status.phone.name,
            pubKey: claim.phonePubKey,
          },
        ],
      };
      // Do not write identity/token/key material until the QR-secret-authenticated
      // claim has been opened successfully.
      saveRelayConfig(config);
      this.pending = null;
      return {
        result: {
          status: "claimed",
          peer: {
            deviceId: status.phone.deviceId,
            name: claim.name ?? status.phone.name,
          },
        },
        config,
      };
    } catch {
      this.pending = null;
      return {
        result: {
          status: "error",
          error: "pairing claim failed authentication",
        },
      };
    }
  }
}
