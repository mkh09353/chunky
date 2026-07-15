// Deterministic AGENTS.md distillation/cache tests. No provider request is made;
// the one-shot model invocation is replaced through the test seam.
import { strict as assert } from "node:assert"
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { distilledAgentsMd, setAgentsMdInvokerForTests } from "./agents-md.ts"
import type { AgentSelection } from "./providers/registry.ts"

const selection: AgentSelection = Object.freeze({ provider: "codex", model: "gpt-5.5", effort: "low" })

function setup() {
  const state = mkdtempSync(join(tmpdir(), "chunky-agents-md-state-"))
  const workspace = mkdtempSync(join(tmpdir(), "chunky-agents-md-repo-"))
  const previous = process.env.CHUNKY_SETTINGS
  process.env.CHUNKY_SETTINGS = join(state, "settings.json")
  return {
    state,
    workspace,
    restore() {
      setAgentsMdInvokerForTests(null)
      if (previous === undefined) delete process.env.CHUNKY_SETTINGS
      else process.env.CHUNKY_SETTINGS = previous
    },
  }
}

function cachePath(state: string): string {
  return join(state, "agents-md")
}

async function main() {
  {
    const t = setup()
    try {
      writeFileSync(join(t.workspace, "AGENTS.md"), "Run bun test.\n")
      let calls = 0
      setAgentsMdInvokerForTests(async () => { calls++; return { content: "- Run `bun test`" } })
      assert.equal(await distilledAgentsMd(t.workspace, selection), "- Run `bun test`")
      assert.equal(await distilledAgentsMd(t.workspace, selection), "- Run `bun test`")
      assert.equal(calls, 1, "a matching hash must skip the model call")
    } finally { t.restore() }
  }

  {
    const t = setup()
    try {
      const file = join(t.workspace, "AGENTS.md")
      writeFileSync(file, "Run bun test.\n")
      let calls = 0
      setAgentsMdInvokerForTests(async () => ({ content: `- rule ${++calls}` }))
      assert.equal(await distilledAgentsMd(t.workspace, selection), "- rule 1")
      writeFileSync(file, "Run bun build.\n")
      assert.equal(await distilledAgentsMd(t.workspace, selection), "- rule 2")
      assert.equal(calls, 2, "a changed hash must re-distill")
    } finally { t.restore() }
  }

  {
    const t = setup()
    try {
      writeFileSync(join(t.workspace, "AGENTS.md"), "No useful rules.\n")
      setAgentsMdInvokerForTests(async () => "NONE")
      assert.equal(await distilledAgentsMd(t.workspace, selection), null)
      assert.ok(existsSync(cachePath(t.state)), "NONE must still create the cache directory")
      const cached = readFileSync(join(cachePath(t.state), readdirSync(cachePath(t.state))[0]!), "utf8")
      assert.equal(JSON.parse(cached).distilled, "")
      setAgentsMdInvokerForTests(async () => { throw new Error("must use cached empty result") })
      assert.equal(await distilledAgentsMd(t.workspace, selection), null)
    } finally { t.restore() }
  }

  {
    const t = setup()
    try {
      assert.equal(await distilledAgentsMd(t.workspace, selection), null)
      assert.equal(existsSync(cachePath(t.state)), false, "missing source must not create a cache")
    } finally { t.restore() }
  }

  {
    const t = setup()
    try {
      writeFileSync(join(t.workspace, "AGENTS.md"), "Run bun test.\n")
      let calls = 0
      setAgentsMdInvokerForTests(async () => {
        calls++
        if (calls === 1) throw new Error("provider unavailable")
        return { content: "- Run `bun test`" }
      })
      assert.equal(await distilledAgentsMd(t.workspace, selection), null)
      assert.equal(existsSync(cachePath(t.state)), false, "distill errors must not write a cache")
      assert.equal(await distilledAgentsMd(t.workspace, selection), "- Run `bun test`")
      assert.equal(calls, 2, "an error must retry next time")
    } finally { t.restore() }
  }

  console.log("PASS: AGENTS.md distillation/cache tests")
}

await main()
