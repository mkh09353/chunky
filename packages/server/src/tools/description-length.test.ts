import { expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

process.env.CHUNKY_SETTINGS = join(mkdtempSync(join(tmpdir(), "chunky-tool-descriptions-")), "settings.json")

const { setAppBrowserEndpoint, resetAppBrowserEndpoint } = await import("../app-browser.ts")
const { setAppZooEndpoint, resetAppZooEndpoint } = await import("../app-zoo.ts")
const { executorToolsFor } = await import("../agent.ts")
const { createChunkySdkMcpServer } = await import("../anthropic-runner.ts")
const { registerProvider } = await import("../providers/registry.ts")
const { setAdvisor, setReview } = await import("../settings.ts")

const MAX_DESCRIPTION_LENGTH = 1900
const selection = { provider: "description-test", model: "executor" } as const

test("every registered agent tool description leaves room below the SDK cap", () => {
  registerProvider({
    id: "description-test",
    label: "Description Test",
    billing: "unknown",
    ready: () => true,
    listModels: async () => [],
    buildModel: () => { throw new Error("unused") },
  })
  setAdvisor({ enabled: true, provider: "description-test", model: "advisor" })
  setReview({ enabled: true, provider: "description-test", model: "reviewer" })
  setAppBrowserEndpoint({ cdpPort: 9223, renderer: "cef", debuggable: true })
  setAppZooEndpoint({ port: 3010, token: "z".repeat(16) })

  try {
    const registered = new Map<string, { name: string; description: string }>()
    for (const profile of ["standard", "hashline"] as const) {
      process.env.CHUNKY_FILE_TOOL_PROFILE = profile
      for (const tool of executorToolsFor(selection).tools) registered.set(`${profile}:${tool.name}`, tool)

      const sdkRegistry = (createChunkySdkMcpServer("description-test", () => {}).instance as any)._registeredTools
      for (const [name, definition] of Object.entries(sdkRegistry) as Array<[string, { description: string }]>) {
        registered.set(`${profile}:sdk:${name}`, { name, description: definition.description })
      }
    }

    expect(registered.size).toBeGreaterThan(0)
    for (const [registration, tool] of registered) {
      expect(tool.description.length, `${registration} (${tool.description.length} chars)`).toBeLessThanOrEqual(MAX_DESCRIPTION_LENGTH)
    }

    const workflowDescription = registered.get("standard:workflow")!.description
    const first1200 = workflowDescription.slice(0, 1200)
    expect(first1200).toContain("agent(prompt: string, opts?)")
    expect(first1200).toContain("Object form { prompt | instructions | task, ...opts } is also accepted")
    expect(first1200).toContain("parallel(thunks)")
    expect(first1200).toContain("Minimal example (3 lines)")
  } finally {
    delete process.env.CHUNKY_FILE_TOOL_PROFILE
    resetAppBrowserEndpoint()
    resetAppZooEndpoint()
  }
})
