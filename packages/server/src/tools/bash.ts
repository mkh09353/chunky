// bash — run a shell command in WORKSPACE via `bash -lc`. This is the agent's
// one navigation/inspection primitive: it deliberately SUBSUMES ls / grep / rg /
// find / cat, so the harness ships four tools instead of a dozen. stdout+stderr
// are combined and tail-truncated (last 2000 lines / 50KB); when truncated the
// FULL output is spilled to a temp file the model can `read`/grep.
import { randomBytes } from "node:crypto"
import { writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { tool } from "@langchain/core/tools"
import { z } from "zod"
import { WORKSPACE } from "../workspace.ts"
import { MAX_BYTES, MAX_LINES, truncateOutput } from "./fs-util.ts"

export const bashInputShape = {
  command: z.string().describe("The bash command."),
  timeout: z.number().optional().describe("Timeout in seconds (optional)."),
}

export const bash = tool(
  async ({ command, timeout }: { command: string; timeout?: number }) => {
    const proc = Bun.spawn(["bash", "-lc", command], {
      cwd: WORKSPACE,
      stdout: "pipe",
      stderr: "pipe",
    })

    let timedOut = false
    let timer: ReturnType<typeof setTimeout> | undefined
    if (timeout && timeout > 0) {
      timer = setTimeout(() => {
        timedOut = true
        proc.kill()
      }, timeout * 1000)
    }

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    const exitCode = await proc.exited
    if (timer) clearTimeout(timer)

    let combined = stdout
    if (stderr) combined += (combined && !combined.endsWith("\n") ? "\n" : "") + stderr

    const { content, truncated } = truncateOutput(combined, { keep: "tail" })
    let out = content
    if (truncated) {
      const tmp = join(tmpdir(), `chunky-bash-${Date.now()}-${randomBytes(4).toString("hex")}.txt`)
      writeFileSync(tmp, combined, "utf-8")
      out += `\n\n[Output truncated. Full output: ${tmp}]`
    }

    const status = timedOut ? `${exitCode} (timed out after ${timeout}s)` : String(exitCode)
    return `${out ? `${out}\n` : ""}[exit code: ${status}]`
  },
  {
    name: "bash",
    description: `Run a shell command in the project root; this is how you list, search (grep/rg), and find files. Combines stdout+stderr, tail-truncated to the last ${MAX_LINES} lines / ${MAX_BYTES / 1000}KB (full output spilled to a temp file). Optional timeout in seconds.`,
    schema: z.object(bashInputShape),
  },
)
