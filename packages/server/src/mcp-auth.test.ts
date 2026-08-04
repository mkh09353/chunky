import { beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

const dir = mkdtempSync(join(tmpdir(), "chunky-mcp-auth-test-"))
process.env.CHUNKY_AUTH = join(dir, "auth.json")
process.env.CHUNKY_SETTINGS = join(dir, "settings.json")
writeFileSync(process.env.CHUNKY_SETTINGS, JSON.stringify({ mcpServers: { gmail: { url: "https://gmailmcp.googleapis.com/mcp/v1", oauth: { clientId: "client", clientSecret: "secret" } } } }))
const { AuthStore } = await import("./providers/auth-store.ts")
const { getFreshAccessToken } = await import("./mcp-auth.ts")
beforeEach(() => AuthStore.remove("mcp-gmail"))

describe("remote MCP OAuth", () => {
  test("does not refresh a token with more than 60 seconds remaining", async () => {
    AuthStore.set("mcp-gmail", { type: "oauth", access: "access-old", refresh: "refresh", expires: Date.now() + 120_000 })
    let calls = 0
    expect(await getFreshAccessToken("gmail", (async () => { calls++; return new Response() }) as any)).toBe("access-old")
    expect(calls).toBe(0)
  })
  test("refreshes within 60 seconds and persists rotated credentials", async () => {
    AuthStore.set("mcp-gmail", { type: "oauth", access: "access-old", refresh: "refresh-old", expires: Date.now() + 59_000 })
    const token = await getFreshAccessToken("gmail", (async (_input: URL | RequestInfo, init?: RequestInit) => {
      expect(init?.method).toBe("POST")
      expect(String(init?.body)).toContain("refresh_token=refresh-old")
      return new Response(JSON.stringify({ access_token: "access-new", refresh_token: "refresh-new", expires_in: 3600 }), { status: 200 })
    }) as any)
    expect(token).toBe("access-new")
    expect(AuthStore.get("mcp-gmail")).toMatchObject({ access: "access-new", refresh: "refresh-new" })
  })
})
