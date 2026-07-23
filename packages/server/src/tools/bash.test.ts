import { afterEach, describe, expect, test } from "bun:test"
import { rmSync } from "node:fs"
import { bash, sanitizedShellEnvironment, setDefaultTimeoutForTests } from "./bash.ts"
import { asToolRunResult, dualTool } from "./result.ts"

const spillPaths: string[] = []

afterEach(() => {
  setDefaultTimeoutForTests()
  for (const path of spillPaths.splice(0)) rmSync(path, { force: true })
})

describe("bash timeout", () => {
  test("foreground commands without a timeout get the default instead of hanging forever", async () => {
    setDefaultTimeoutForTests(0.1)
    const started = Date.now()
    const output = await bash.invoke({ command: "sleep 30" })

    expect(Date.now() - started).toBeLessThan(2_000)
    expect(String(output)).toContain("timed out after 0.1s — default")
    expect(String(output)).toContain("background=true")
  })

  test("terminates descendants that inherit the command pipes", async () => {
    const started = Date.now()
    const output = await bash.invoke({ command: "sleep 5 & wait", timeout: 0.1 })

    expect(Date.now() - started).toBeLessThan(2_000)
    expect(String(output)).toContain("timed out after 0.1s")
  })

  test("settles when a backgrounded compound command outlives its wrapper shell", async () => {
    const started = Date.now()
    const output = await bash.invoke({
      command: "cd /tmp && sleep 5 >/dev/null 2>&1 & echo background-pid:$!",
      timeout: 0.1,
    })

    expect(Date.now() - started).toBeLessThan(2_000)
    expect(String(output)).toContain("timed out after 0.1s")

    const pid = Number(String(output).match(/background-pid:(\d+)/)?.[1])
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, "SIGTERM")
      } catch {
        // It already exited.
      }
    }
  })
})

describe("bash environment isolation", () => {
  test("does not expose launcher-owned production state paths to agent commands", () => {
    const env = sanitizedShellEnvironment({
      PATH: "/safe/bin",
      SAFE_USER_VALUE: "kept",
      CHUNKY_DB: "/Users/example/.chunky/state/chunky.db",
      CHUNKY_GRAPH_DB: "/Users/example/.chunky/state/chunky-graph.db",
      CHUNKY_SETTINGS: "/Users/example/.chunky/state/settings.json",
      CHUNKY_AUTH: "/Users/example/.chunky/state/auth.json",
      CHUNKY_PORT: "4620",
      CHUNKY_WORKSPACE: "/Users/example/project",
      CHUNKY_VERSION: "0.3.20",
      CHUNKY_BUILD_ID: "build",
      CHUNKY_SERVER_NONCE: "nonce",
      CHUNKY_SERVER_ID: "server",
      CHUNKY_DISCOVERY_RECORD: "/Users/example/.chunky/state/servers/record.json",
    })

    expect(env).toEqual({ PATH: "/safe/bin", SAFE_USER_VALUE: "kept" })
  })
})

describe("bash background processes", () => {
  test("returns promptly when a backgrounded process holds the pipe open, keeping foreground output", async () => {
    const started = Date.now()
    const output = await bash.invoke({ command: "sleep 10 & echo server-started" })

    expect(Date.now() - started).toBeLessThan(5_000)
    expect(String(output)).toContain("server-started")
    expect(String(output)).toContain("[exit code: 0]")
    expect(String(output)).toContain("background process is still running")
  })

  test("no grace delay or note for ordinary commands", async () => {
    const started = Date.now()
    const output = await bash.invoke({ command: "echo done" })

    expect(Date.now() - started).toBeLessThan(1_000)
    expect(String(output)).toContain("done")
    expect(String(output)).not.toContain("background process")
  })

  test("returns prompt text separately from structured execution metadata", async () => {
    const result = asToolRunResult(await bash.invoke({ command: "printf hello" }))

    expect(result.promptText).toContain("hello")
    expect(result.promptText).toContain("[exit code: 0]")
    expect(result.raw).toMatchObject({
      kind: "bash",
      command: "printf hello",
      exitCode: 0,
      timedOut: false,
      truncated: false,
      rawBytes: 5,
    })
  })

  test("the LangChain adapter exposes only prompt text as message content", async () => {
    const message = await dualTool(bash).invoke({ command: "printf adapted" }, { toolCall: { id: "bash-1" } } as any)

    expect(message.content).toContain("adapted")
    expect(message.content).not.toContain("rawBytes")
    expect(message.artifact).toMatchObject({
      promptText: expect.stringContaining("adapted"),
      raw: { kind: "bash", exitCode: 0, rawBytes: 7 },
      ok: true,
    })
  })

  test("reports truncation and a recoverable spill path without embedding raw output", async () => {
    const result = asToolRunResult(await bash.invoke({ command: "yes x | head -n 25000" }))
    const raw = result.raw as any
    spillPaths.push(raw.spillPath)

    expect(raw).toMatchObject({
      kind: "bash",
      exitCode: 0,
      truncated: true,
      rawBytes: 50_000,
    })
    expect(raw.spillPath).toBeString()
    expect(result.promptText).toContain(`full output: ${raw.spillPath}`)
    expect(result.promptText.length).toBeLessThan(raw.rawBytes)
  })
})
