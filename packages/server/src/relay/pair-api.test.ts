import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "chunky-relay-api-"));
const token = "local-server-token";
const relay = Bun.serve({
  port: 0,
  fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/pair/begin")
      return Response.json({
        code: "PAIR",
        deviceId: "computer",
        deviceToken: "relay-device-token",
        expiresAt: Date.now() + 60_000,
      });
    if (path === "/pair/PAIR/status") {
      expect(req.headers.get("authorization")).toBe(
        "Bearer relay-device-token",
      );
      return Response.json({
        status: "pending",
        expiresAt: Date.now() + 60_000,
      });
    }
    return new Response("not found", { status: 404 });
  },
});
const listener = Bun.listen({
  hostname: "127.0.0.1",
  port: 0,
  socket: {
    data() {
      return undefined;
    },
  },
});
const port = listener.port;
listener.stop();
writeFileSync(
  join(root, "settings.json"),
  JSON.stringify({ serverToken: token }),
);
const proc = Bun.spawn(
  [process.execPath, "run", "packages/server/src/index.ts"],
  {
    cwd: join(import.meta.dir, "../../../../"),
    env: {
      ...process.env,
      CHUNKY_PORT: String(port),
      CHUNKY_SETTINGS: join(root, "settings.json"),
      CHUNKY_DB: join(root, "chunky.db"),
      CHUNKY_RELAY_CONFIG: join(root, "relay.json"),
      CHUNKY_RELAY_URL: `http://127.0.0.1:${relay.port}`,
      CHUNKY_RELAY: "0",
    },
    stdout: "ignore",
    stderr: "ignore",
  },
);
const base = `http://127.0.0.1:${port}`;
async function request(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  let error: unknown;
  for (let i = 0; i < 80; i++) {
    try {
      return await fetch(base + path, init);
    } catch (err) {
      error = err;
      await Bun.sleep(25);
    }
  }
  throw error;
}
afterAll(async () => {
  proc.kill("SIGTERM");
  await proc.exited;
  relay.stop(true);
  rmSync(root, { recursive: true, force: true });
});

describe("local relay pairing API", () => {
  test("requires local bearer auth and exposes only canonical sanitized lifecycle fields", async () => {
    expect((await request("/api/relay")).status).toBe(401);
    const auth = { Authorization: `Bearer ${token}` };
    expect(
      await (await request("/api/relay", { headers: auth })).json(),
    ).toEqual({ paired: false, enabled: false });
    const begun = await request("/api/relay/begin", {
      method: "POST",
      headers: auth,
    });
    expect(begun.status).toBe(200);
    const body = (await begun.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      "expiresAt",
      "name",
      "qrPayload",
      "relayUrl",
    ]);
    expect(body.qrPayload).toBeString();
    expect(String(body.qrPayload)).toStartWith("chunky1:");
    expect(JSON.stringify(body)).not.toContain("relay-device-token");
    const polled = await request("/api/relay/poll", {
      method: "POST",
      headers: auth,
    });
    expect(await polled.json()).toEqual({
      status: "pending",
      expiresAt: expect.any(Number),
    });
  });
});
