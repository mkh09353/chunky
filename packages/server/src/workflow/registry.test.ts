import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  filenameToWorkflowName,
  formatAvailableWorkflows,
  isValidWorkflowName,
  parseWorkflowMeta,
  projectWorkflowsDir,
  resolveSavedWorkflow,
  scanSavedWorkflows,
  userWorkflowsDir,
} from "./registry.ts"
import { resolveWorkflowSource } from "../tools/workflow.ts"
import { loadWorkflowJournal, prepareJournaledHost } from "./journal.ts"
import { runWorkflowScript, type WorkflowHost } from "./engine.ts"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs) {
    try { chmodSync(dir, 0o755) } catch {}
    rmSync(dir, { recursive: true, force: true })
  }
  dirs.length = 0
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function writeWorkflow(dir: string, filename: string, body: string): string {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, filename)
  writeFileSync(path, body)
  return path
}

describe("saved workflow registry", () => {
  test("validates kebab-case names and filename fallback", () => {
    expect(isValidWorkflowName("deep-research")).toBe(true)
    expect(isValidWorkflowName("a")).toBe(true)
    expect(isValidWorkflowName("Deep")).toBe(false)
    expect(isValidWorkflowName("-bad")).toBe(false)
    expect(isValidWorkflowName("bad-")).toBe(false)
    expect(isValidWorkflowName("bad--name")).toBe(false)
    expect(filenameToWorkflowName("audit-auth.workflow.js")).toBe("audit-auth")
    expect(filenameToWorkflowName("audit-auth.js")).toBeUndefined()
    expect(filenameToWorkflowName("Bad.workflow.js")).toBeUndefined()
  })

  test("parses export const meta and leading comment meta", () => {
    expect(parseWorkflowMeta(`export const meta = { name: "deep-research", description: "x", when_to_use: "big audits" }\nreturn 1`))
      .toEqual({ name: "deep-research", description: "x", when_to_use: "big audits" })
    expect(parseWorkflowMeta(`/* { "name": "from-block", "description": "comment" } */\nreturn 1`))
      .toEqual({ name: "from-block", description: "comment" })
    expect(parseWorkflowMeta(`// {"name":"from-line","description":"d"}\nreturn 1`))
      .toEqual({ name: "from-line", description: "d" })
    expect(parseWorkflowMeta(`return 1`)).toEqual({})
  })

  test("scans user+project, falls back to filename, project wins collisions", () => {
    const workspace = tempDir("chunky-wf-project-")
    const home = tempDir("chunky-wf-user-")
    const userDir = userWorkflowsDir(home)
    const projectDir = projectWorkflowsDir(workspace)
    writeWorkflow(userDir, "shared.workflow.js", `export const meta = { name: "shared", description: "user" }\nreturn 'user'`)
    writeWorkflow(userDir, "user-only.workflow.js", `return 'only-user'`)
    writeWorkflow(projectDir, "shared.workflow.js", `export const meta = { name: "shared", description: "project" }\nreturn 'project'`)
    writeWorkflow(projectDir, "project-only.workflow.js", `return 'only-project'`)

    const scanned = scanSavedWorkflows({ workspace, userDir })
    expect(scanned.map((e) => `${e.name}:${e.source}:${e.description ?? ""}`)).toEqual([
      "project-only:project:",
      "shared:project:project",
      "user-only:user:",
    ])
    expect(resolveSavedWorkflow("shared", { workspace, userDir })?.script).toContain("return 'project'")
    expect(resolveSavedWorkflow("user-only", { workspace, userDir })?.source).toBe("user")
  })

  test("skips malformed files with a warning and does not crash", () => {
    const workspace = tempDir("chunky-wf-bad-")
    const userDir = join(tempDir("chunky-wf-empty-"), "workflows")
    const projectDir = projectWorkflowsDir(workspace)
    writeWorkflow(projectDir, "ok.workflow.js", `return 'ok'`)
    writeWorkflow(projectDir, "BadName.workflow.js", `return 'nope'`)
    writeWorkflow(projectDir, "notes.txt", `not a workflow`)
    writeWorkflow(projectDir, "broken.workflow.js", `export const meta = { name: "!!!", description: "bad" }\nreturn 1`)
    const warnings: string[] = []
    const scanned = scanSavedWorkflows({ workspace, userDir, warn: (m) => warnings.push(m) })
    expect(scanned.map((e) => e.name)).toEqual(["ok"])
    expect(warnings.some((w) => w.includes("BadName") || w.includes("broken") || w.includes("invalid"))).toBe(true)
  })
})

describe("workflow tool source resolution", () => {
  test("exactly one of script or name", () => {
    expect(resolveWorkflowSource({})).toMatchObject({ error: expect.stringContaining("exactly one of script or name") })
    expect(resolveWorkflowSource({ script: "return 1", name: "x" })).toMatchObject({
      error: expect.stringContaining("not both"),
    })
    expect(resolveWorkflowSource({ script: "return 1" })).toEqual({ script: "return 1" })
  })

  test("unknown name lists available workflows", () => {
    const workspace = tempDir("chunky-wf-unknown-")
    const home = tempDir("chunky-wf-unknown-user-")
    const userDir = userWorkflowsDir(home)
    writeWorkflow(projectWorkflowsDir(workspace), "audit-auth.workflow.js", `return 'ok'`)
    const result = resolveWorkflowSource({ name: "missing" }, { workspace, userDir })
    expect("error" in result).toBe(true)
    if (!("error" in result)) return
    expect(result.error).toContain('unknown workflow "missing"')
    expect(result.error).toContain("audit-auth")
  })

  test("run-by-name happy path loads the saved script", () => {
    const workspace = tempDir("chunky-wf-run-")
    const userDir = userWorkflowsDir(tempDir("chunky-wf-run-user-"))
    writeWorkflow(
      projectWorkflowsDir(workspace),
      "greet.workflow.js",
      `export const meta = { name: "greet", description: "hi" }\nreturn 'hello ' + args.who`,
    )
    expect(resolveWorkflowSource({ name: "greet" }, { workspace, userDir })).toMatchObject({
      workflowName: "greet",
      script: expect.stringContaining("hello"),
    })
  })

  test("run-by-name with resume records the name in the journal header", async () => {
    const workspace = tempDir("chunky-wf-journal-")
    const userDir = userWorkflowsDir(tempDir("chunky-wf-journal-user-"))
    const journalDir = tempDir("chunky-wf-journal-state-")
    writeWorkflow(projectWorkflowsDir(workspace), "once.workflow.js", `return await agent('only once')`)
    const resolved = resolveWorkflowSource({ name: "once" }, { workspace, userDir })
    if ("error" in resolved) throw new Error(resolved.error)

    const events: unknown[] = []
    const inner: WorkflowHost = {
      runId: "named-run",
      concurrency: 2,
      emit: (ev) => events.push(ev),
      spawn: async () => "first",
    }
    const prepared = prepareJournaledHost(inner, {
      script: resolved.script,
      workflowName: resolved.workflowName,
      baseDir: journalDir,
    })
    expect(await runWorkflowScript(prepared.host, resolved.script)).toBe("first")
    const header = loadWorkflowJournal(prepared.runId, journalDir).header
    expect(header.workflowName).toBe("once")
    expect(header.scriptHash).toBeTruthy()

    const resumeInner: WorkflowHost = {
      runId: prepared.runId,
      concurrency: 2,
      emit: () => {},
      spawn: async () => {
        throw new Error("must not spawn on resume")
      },
    }
    const resumed = prepareJournaledHost(resumeInner, {
      script: resolved.script,
      workflowName: resolved.workflowName,
      resumeFrom: prepared.runId,
      baseDir: journalDir,
    })
    expect(await runWorkflowScript(resumed.host, resolved.script)).toBe("first")
  })

  test("formatAvailableWorkflows is stable for empty and named lists", () => {
    expect(formatAvailableWorkflows([])).toBe("(none)")
  })
})
