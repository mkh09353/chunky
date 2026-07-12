import { describe, expect, test } from "bun:test"
import { bash } from "./bash.ts"

describe("bash timeout", () => {
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
