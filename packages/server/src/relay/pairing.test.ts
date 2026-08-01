import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodePairingQR,
  generateDeviceKeyPair,
  sealPairingClaim,
  toB64,
} from "@chunky/protocol/relay-crypto";
import { RelayPairing, relayStatus } from "./pairing.ts";

const root = mkdtempSync(join(tmpdir(), "chunky-relay-pairing-"));
const configPath = join(root, "relay.json");
const oldFetch = globalThis.fetch;
const oldConfig = process.env.CHUNKY_RELAY_CONFIG;
const oldUrl = process.env.CHUNKY_RELAY_URL;
process.env.CHUNKY_RELAY_CONFIG = configPath;
process.env.CHUNKY_RELAY_URL = "https://relay.test";

afterEach(() => {
  globalThis.fetch = oldFetch;
  rmSync(configPath, { force: true });
});
afterAll(() => {
  if (oldConfig === undefined) delete process.env.CHUNKY_RELAY_CONFIG;
  else process.env.CHUNKY_RELAY_CONFIG = oldConfig;
  if (oldUrl === undefined) delete process.env.CHUNKY_RELAY_URL;
  else process.env.CHUNKY_RELAY_URL = oldUrl;
  rmSync(root, { recursive: true, force: true });
});

describe("RelayPairing", () => {
  test("returns only an ephemeral QR, validates claim before 0600 persistence, and sanitizes status", async () => {
    const phone = generateDeviceKeyPair();
    let qr = "";
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.endsWith("/pair/begin")) {
        return Response.json({
          code: "CODE",
          deviceId: "computer-id",
          deviceToken: "computer-token",
          expiresAt: Date.now() + 60_000,
        });
      }
      const parsed = decodePairingQR(qr);
      expect(url).toBe("https://relay.test/pair/CODE/status");
      return Response.json({
        status: "claimed",
        claim: sealPairingClaim(
          { phonePubKey: toB64(phone.publicKey), name: "Phone" },
          Uint8Array.from(atob(parsed.secret), (c) => c.charCodeAt(0)),
        ),
        phone: {
          deviceId: "phone-id",
          kind: "phone",
          name: "relay-name",
          online: false,
          lastSeen: null,
        },
        accountId: "account-secret-not-returned",
      });
    }) as typeof fetch;
    const pairing = new RelayPairing();
    const begun = await pairing.begin("Desktop");
    qr = begun.qrPayload;
    expect(Object.keys(begun).sort()).toEqual([
      "expiresAt",
      "name",
      "qrPayload",
      "relayUrl",
    ]);
    expect(begun.qrPayload).toStartWith("chunky1:");
    expect(existsSync(configPath)).toBeFalse;
    const { result } = await pairing.poll();
    expect(result).toEqual({
      status: "claimed",
      peer: { deviceId: "phone-id", name: "Phone" },
    });
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
    const saved = readFileSync(configPath, "utf8");
    expect(saved).toContain("computer-token");
    expect(relayStatus()).toEqual({
      paired: true,
      enabled: true,
      relayUrl: "https://relay.test",
      peers: [{ deviceId: "phone-id", name: "Phone" }],
    });
    expect(JSON.stringify(relayStatus())).not.toContain("computer-token");
    expect(JSON.stringify(relayStatus())).not.toContain("account-secret");
  });

  test("rejects malformed pair-begin responses without retaining state or secrets", async () => {
    let begins = 0;
    globalThis.fetch = (async () => {
      begins++;
      return Response.json({ code: "CODE", deviceId: "computer-id", expiresAt: Date.now() + 60_000 });
    }) as unknown as typeof fetch;
    const pairing = new RelayPairing();
    await expect(pairing.begin()).rejects.toThrow("relay returned an invalid pairing response");
    await expect(pairing.begin()).rejects.toThrow("relay returned an invalid pairing response");
    expect(begins).toBe(2);
    expect(existsSync(configPath)).toBeFalse;
  });

  test("returns a sanitized error and retains no config for malformed pair-status", async () => {
    globalThis.fetch = (async (input) => {
      if (String(input).endsWith("/pair/begin")) {
        return Response.json({ code: "CODE", deviceId: "computer-id", deviceToken: "computer-token", expiresAt: Date.now() + 60_000 });
      }
      return Response.json({
        status: "claimed",
        claim: "opaque-claim",
        phone: { deviceId: "phone-id", name: "Phone" },
        // Canonical PairStatusResponse requires accountId too.
      });
    }) as typeof fetch;
    const pairing = new RelayPairing();
    await pairing.begin();
    expect((await pairing.poll()).result).toEqual({ status: "error", error: "relay returned an invalid pairing response" });
    expect(existsSync(configPath)).toBeFalse;
  });

  test("reuses the exact pending QR without a second relay begin", async () => {
    let begins = 0;
    globalThis.fetch = (async () => {
      begins++;
      return Response.json({
        code: "CODE",
        deviceId: "computer-id",
        deviceToken: "computer-token",
        expiresAt: 10_000,
      });
    }) as unknown as typeof fetch;
    const pairing = new RelayPairing(() => 9_000);
    const first = await pairing.begin("Desktop");
    const resumed = await pairing.begin("Different ignored name");
    expect(resumed).toEqual(first);
    expect(begins).toBe(1);
  });

  test("clears expired pending state and starts a fresh pairing", async () => {
    let now = 1_000;
    let begins = 0;
    globalThis.fetch = (async () => {
      begins++;
      return Response.json({
        code: `CODE-${begins}`,
        deviceId: "computer-id",
        deviceToken: "computer-token",
        expiresAt: 2_000,
      });
    }) as unknown as typeof fetch;
    const pairing = new RelayPairing(() => now);
    const first = await pairing.begin("Desktop");
    now = 62_001; // expiresAt + the same 60s local backstop used by poll().
    const fresh = await pairing.begin("Desktop");
    expect(begins).toBe(2);
    expect(fresh.qrPayload).not.toBe(first.qrPayload);
    expect(fresh.expiresAt).toBe(2_000);
  });

  test("does not persist a forged claim", async () => {
    globalThis.fetch = (async (input) => {
      if (String(input).endsWith("/pair/begin"))
        return Response.json({
          code: "CODE",
          deviceId: "computer-id",
          deviceToken: "computer-token",
          expiresAt: Date.now() + 60_000,
        });
      return Response.json({
        status: "claimed",
        claim: "not-a-valid-secretbox",
        phone: {
          deviceId: "phone-id",
          kind: "phone",
          name: "Phone",
          online: false,
          lastSeen: null,
        },
        accountId: "account",
      });
    }) as typeof fetch;
    const pairing = new RelayPairing();
    await pairing.begin();
    expect((await pairing.poll()).result).toEqual({
      status: "error",
      error: "pairing claim failed authentication",
    });
    expect(existsSync(configPath)).toBeFalse;
  });
});
