import { expect, test } from "bun:test"
import { homedir } from "node:os"
import { agentPlanFor } from "./agent.ts"
import { buildRepoLessSystemPrompt } from "./prompt.ts"
import { Store } from "./store.ts"
import { type AgentForSelection, ThreadManager } from "./threads.ts"
import { runtimeWorkspace } from "./workspace.ts"

test("repository-less sessions retain the full filesystem tool plan", () => {
  const sessionId = `repo-less-tools-${process.pid}`
  Store.createSession(sessionId, "Chat", null, "none")

  const names = new Set(agentPlanFor({ provider: "zen", model: "glm-5.2" }, sessionId).tools.map((tool) => tool.name))

  expect(names).toContain("bash")
  expect(names).toContain("read")
  expect(names).toContain("write")
  expect(names).toContain("edit")
})

test("repository-less runtime workspace is home without changing persisted identity", () => {
  const sessionId = `repo-less-workspace-${process.pid}`
  Store.createSession(sessionId, "Chat", null, "none")

  expect(runtimeWorkspace(Store.workspaceOf(sessionId), Store.repositoryScopeOf(sessionId))).toBe(homedir())
  expect(Store.summary(sessionId)).toMatchObject({ workspace: null, repositoryScope: "none" })
})

test("repository-less prompt permits normal tools and cloning", () => {
  const prompt = buildRepoLessSystemPrompt("edit", false, homedir())
  expect(prompt).toContain(`Working directory: ${homedir()}`)
  expect(prompt).toContain("No repository is pinned")
  expect(prompt).toContain("clone, fetch, or inspect anything")
  expect(prompt).not.toContain("Do not attempt repository")
})


test("repository-less child delegation inherits the home workspace and root scope", async () => {
  const sessionId = `repo-less-child-${process.pid}`
  Store.createSession(sessionId, "Chat", null, "none")
  const calls: Array<{ workspace: string; sessionId?: string; configuredWorkspace?: string }> = []
  const fakeAgent: AgentForSelection = (_selection, workspace, _agentsMd, rootSessionId) => ({
    async stream(_input, config) {
      calls.push({ workspace, sessionId: rootSessionId, configuredWorkspace: (config as any).configurable.workspace })
      return (async function* () { yield ["messages", [{ type: "ai", content: "done" }]] })()
    },
  })
  const manager = new ThreadManager(() => {}, sessionId, { provider: "zen", model: "glm-5.2" }, fakeAgent, undefined, homedir())

  try {
    await manager.spawn({ callerThreadId: sessionId, title: "inspect", instructions: "inspect files" })
  } finally {
    manager.dispose()
  }

  expect(calls).toEqual([{ workspace: homedir(), sessionId, configuredWorkspace: homedir() }])
  expect(Store.summary(sessionId)).toMatchObject({ workspace: null, repositoryScope: "none" })
})
