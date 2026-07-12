// bash — run a shell command in the run's workspace via `bash -lc`. This is the agent's
// one navigation/inspection primitive: it deliberately SUBSUMES ls / grep / rg /
// find / cat, so the harness ships four tools instead of a dozen.
//
// stdout+stderr are combined, lightly cleaned (ANSI / progress / blanks), optionally
// reduced by a command-aware filter (git / gh / package managers / tsc / tests),
// then signal-preserving-truncated (head + error lines + tail). When the body is
// still shortened vs the full cleaned output, the FULL original is spilled to a
// temp file the model can `read`/grep.
import { randomBytes } from "node:crypto"
import { writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { tool } from "@langchain/core/tools"
import { z } from "zod"
import { workspaceFromConfig } from "../workspace.ts"
import { MAX_BYTES, MAX_LINES } from "./fs-util.ts"
import { compressBashOutput } from "./compress.ts"

export const bashInputShape = {
  command: z.string().describe("The bash command."),
  timeout: z.number().optional().describe("Timeout in seconds (optional)."),
}

/** Return every descendant PID before killing anything, while parent/child
 * links are still intact. Long-lived dev commands commonly add two or three
 * wrapper layers (pnpm -> shell -> vite/tsx). */
function descendantPids(rootPid: number): number[] {
  const found: number[] = []
  const visit = (parentPid: number) => {
    const result = Bun.spawnSync(["pgrep", "-P", String(parentPid)], { stdout: "pipe", stderr: "ignore" })
    const children = result.stdout
      .toString()
      .split(/\s+/)
      .map(Number)
      .filter((pid) => Number.isInteger(pid) && pid > 0)
    for (const pid of children) {
      visit(pid)
      found.push(pid)
    }
  }
  visit(rootPid)
  return found
}

function signalPids(pids: number[], signal: NodeJS.Signals): void {
  for (const pid of pids) {
    try {
      process.kill(pid, signal)
    } catch {
      // It exited between discovery and signaling.
    }
  }
}

/** Killing only the wrapper shell leaves descendants holding stdout/stderr
 * open, so Response(stream).text() never settles. Snapshot and terminate the
 * complete tree, deepest-first, then force any TERM-resistant processes down. */
function terminateProcessTree(rootPid: number): void {
  const pids = [...descendantPids(rootPid), rootPid]
  signalPids(pids, "SIGTERM")
  setTimeout(() => signalPids(pids, "SIGKILL"), 250)
}

export const bash = tool(
  async ({ command, timeout }: { command: string; timeout?: number }, config?: unknown) => {
    const proc = Bun.spawn(["bash", "-lc", command], {
      cwd: workspaceFromConfig(config),
      stdout: "pipe",
      stderr: "pipe",
    })

    let timedOut = false
    let timer: ReturnType<typeof setTimeout> | undefined
    if (timeout && timeout > 0) {
      timer = setTimeout(() => {
        timedOut = true
        terminateProcessTree(proc.pid)
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

    const { content, truncated, originalLines, reducer } = compressBashOutput(command, combined)
    let out = content

    // Spill when we dropped content (size cap OR reducer) so the model can recover.
    // Compare against the raw combined output — if cleanup alone shortened it but
    // nothing meaningful was lost (ANSI only), still fine to skip spill when equal
    // enough; we spill whenever `truncated` is set by compress.
    if (truncated && combined.length > 0 && content.length < combined.length) {
      const tmp = join(tmpdir(), `chunky-bash-${Date.now()}-${randomBytes(4).toString("hex")}.txt`)
      writeFileSync(tmp, combined, "utf-8")
      const bits = [`full output: ${tmp}`]
      if (originalLines > 0) bits.unshift(`kept compressed view of ${originalLines} lines`)
      if (reducer) bits.push(`reducer=${reducer}`)
      out += `\n\n[Output truncated. ${bits.join(" · ")}. Re-read with read/rg if you need more.]`
    }

    const status = timedOut ? `${exitCode} (timed out after ${timeout}s)` : String(exitCode)
    return `${out ? `${out}\n` : ""}[exit code: ${status}]`
  },
  {
    name: "bash",
    description: `Run a shell command in the project root; this is how you list, search (grep/rg), and find files. Combines stdout+stderr, compresses noisy tool output (git/gh/npm/tsc/tests), signal-truncates to ~${MAX_LINES} lines / ${MAX_BYTES / 1000}KB (full output spilled to a temp file). Optional timeout in seconds.`,
    schema: z.object(bashInputShape),
  },
)
