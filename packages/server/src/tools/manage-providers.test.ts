import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

const dir = mkdtempSync(join(tmpdir(), "chunky-manage-providers-"))
process.env.CHUNKY_SETTINGS = join(dir, "settings.json")
process.env.CHUNKY_AUTH = join(dir, "auth.json")
const { AuthStore } = await import("../providers/auth-store.ts")
const { manageProviders } = await import("./manage-providers.ts")

afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe("manage_providers", () => {
  test("add, list, test, and remove round-trip custom provider metadata and auth", async () => {
    const service = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ data: [] }) })
    try {
      expect(await manageProviders("add", {
        id: "tool-custom", label: "Tool Custom", baseURL: `http://127.0.0.1:${service.port}/v1`, defaultModel: "example", billing: "metered",
      })).toEqual({ id: "tool-custom", label: "Tool Custom", ready: false })

      const listed = await manageProviders("list") as { providers: Array<{ id: string; ready: boolean; active: boolean; custom: boolean }> }
      expect(listed.providers.find((provider) => provider.id === "tool-custom")).toMatchObject({ ready: false, custom: true })
      expect(listed.providers.filter((provider) => provider.active)).toHaveLength(1)

      expect(await manageProviders("test", { id: "tool-custom" })).toEqual({ id: "tool-custom", ok: false, error: "Missing API key for tool-custom" })
      AuthStore.set("tool-custom", { type: "api", key: "test-secret" })
      expect(await manageProviders("test", { id: "tool-custom" })).toEqual({ id: "tool-custom", ok: true })

      expect(await manageProviders("remove", { id: "tool-custom" })).toEqual({ removed: "tool-custom" })
      expect(AuthStore.getApiKey("tool-custom")).toBeUndefined()
      const after = await manageProviders("list") as { providers: Array<{ id: string }> }
      expect(after.providers.some((provider) => provider.id === "tool-custom")).toBe(false)
    } finally {
      service.stop(true)
    }
  })

  test("rejects reserved ids and non-http base URLs", async () => {
    expect(manageProviders("add", { id: "codex", label: "No", baseURL: "https://example.test" })).rejects.toThrow("reserved")
    expect(manageProviders("remove", { id: "anthropic" })).rejects.toThrow("reserved")
    expect(manageProviders("add", { id: "bad-url", label: "No", baseURL: "file:///tmp/provider" })).rejects.toThrow("http or https")
  })
})
