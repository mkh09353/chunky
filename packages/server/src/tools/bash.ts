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
import { mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { isIncognitoSession } from "../incognito.ts"
import { join } from "node:path"
import { tool } from "@langchain/core/tools"
import { z } from "zod"
import { workspaceFromConfig } from "../workspace.ts"
import { MAX_BYTES, MAX_LINES } from "./fs-util.ts"
import { compressBashOutput } from "./compress.ts"
import { toolResult } from "./result.ts"
import { appendReminder, appendTaskOutput, createTask, finishTask, markTaskTimedOut, taskSpillPath } from "../tasks.ts"
import { routeBackgroundNotice } from "../background-dispatch.ts"
import { terminateProcessTree } from "../process-tree.ts"

// Commands still run under `bash -lc` (the model writes bash, so bash semantics
// are guaranteed), but PATH is snapshotted once from the user's real login shell
// ($SHELL -lc). On macOS the login shell is zsh, so version managers (rbenv /
// mise / asdf / nvm shims) are initialized in ~/.zprofile — which bash never
// reads, leaving `ruby` etc. resolving to the system binary. All of those
// managers work via PATH shims, so importing PATH alone makes tools resolve
// exactly like the user's terminal.
let loginPath: string | null | undefined

async function userLoginPath(): Promise<string | null> {
  if (loginPath !== undefined) return loginPath
  loginPath = null
  const shell = process.env.SHELL
  if (shell && !shell.endsWith("/bash") && !shell.endsWith("/sh")) {
    try {
      const proc = Bun.spawn([shell, "-lc", 'printf %s "$PATH"'], { stdout: "pipe", stderr: "ignore" })
      const timer = setTimeout(() => proc.kill(), 5000)
      const out = (await new Response(proc.stdout).text()).trim()
      clearTimeout(timer)
      if ((await proc.exited) === 0 && out.includes("/")) loginPath = out
    } catch { /* fall back to inherited PATH */ }
  }
  return loginPath
}

/** Test seam: reset the cached login-shell PATH snapshot. */
export function resetLoginPathForTests(): void {
  loginPath = undefined
}

export const bashInputShape = {
  command: z.string().describe("The bash command."),
  timeout: z.number().optional().describe("Timeout in seconds (optional)."),
  background: z.boolean().optional().describe("Run asynchronously and return a task ID."),
  description: z.string().optional().describe("Short label for the background task."),
  ready_pattern: z.string().optional().describe("Regex to notify once when a background task is ready; valid only with background=true."),
}

// Date awareness without cache misses: instead of putting the (mutable) current
// date in the system prompt, stamp it onto a bash result only when it differs
// from the last stamp this thread saw — once at session start, then again only
// after crossing midnight. Keyed per thread so every session gets its stamp.
const lastDateStamp = new Map<string, string>()
export function dateStampFor(threadId: unknown): string {
  const key = typeof threadId === "string" && threadId ? threadId : "default"
  const today = new Intl.DateTimeFormat("sv-SE", { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date())
  if (lastDateStamp.get(key) === today) return ""
  lastDateStamp.set(key, today)
  return `\n[today: ${today}]`
}

async function readPipe(reader: ReadableStreamDefaultReader<Uint8Array>, onChunk?: (chunk: string) => void): Promise<string> {
  const decoder = new TextDecoder()
  let text = ""
  while (true) {
    const { done, value } = await reader.read()
    if (done) { const tail = decoder.decode(); if (tail) onChunk?.(tail); return text + tail }
    const chunk = decoder.decode(value, { stream: true })
    if (chunk) onChunk?.(chunk)
    text += chunk
  }
}

export const bash = tool(
  async ({ command, timeout, background, description, ready_pattern }: { command: string; timeout?: number; background?: boolean; description?: string; ready_pattern?: string }, config?: any) => {
    const threadId = config?.configurable?.thread_id
    if (ready_pattern && !background) return toolResult("ready_pattern is only valid with background=true.", { ok: false })
    let readyRegex: RegExp | undefined
    if (ready_pattern) try { readyRegex = new RegExp(ready_pattern) } catch { return toolResult("ready_pattern must be a valid regular expression.", { ok: false }) }
    const path = await userLoginPath()
    const proc = Bun.spawn(["bash", "-lc", command], {
      cwd: workspaceFromConfig(config),
      env: path ? { ...process.env, PATH: path } : process.env,
      stdout: "pipe",
      stderr: "pipe",
    })

    if (background) {
      const { sessionForThread } = await import("../thread-context.ts")
      const sessionId = sessionForThread(threadId) ?? threadId
      if (!sessionId) return toolResult("Background tasks require an active session.", { ok: false })
      const spillPath = taskSpillPath(sessionId)
      const record = createTask(sessionId, { command, description, spillPath, process: proc })
      let readyNotified = false, linePending = ""
      const observe = (chunk: string) => {
        if (!readyRegex || readyNotified) return
        const bits = (linePending + chunk).split(/\r?\n/); linePending = bits.pop() ?? ""
        for (const line of bits) if (readyRegex.test(line)) {
          readyNotified = true
          const text = `Background task ${record.taskId} is ready: matched /${ready_pattern}/ on line: ${line}`
          if (routeBackgroundNotice(sessionId, text, text) === "reminder") appendReminder(sessionId, text)
          break
        }
      }
      const readers = [proc.stdout.getReader(), proc.stderr.getReader()]
      const read = async (reader: ReadableStreamDefaultReader<Uint8Array>) => {
        const decoder = new TextDecoder()
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            const chunk = decoder.decode(value, { stream: true }); appendTaskOutput(record, chunk); observe(chunk)
          }
          const tail = decoder.decode()
          if (tail) { appendTaskOutput(record, tail); observe(tail) }
        } finally { reader.releaseLock() }
      }
      const timeoutTimer = timeout && timeout > 0 ? setTimeout(() => {
        markTaskTimedOut(record)
        terminateProcessTree(proc.pid)
      }, timeout * 1000) : undefined
      void (async () => {
        const reads = readers.map(read)
        const exitCode = await proc.exited
        let graceTimer: ReturnType<typeof setTimeout> | undefined
        await Promise.race([Promise.all(reads).then(() => undefined), new Promise<void>((resolve) => {
          graceTimer = setTimeout(resolve, 1500)
          graceTimer.unref?.()
        })])
        if (graceTimer) clearTimeout(graceTimer)
        if (graceTimer) { for (const reader of readers) void reader.cancel().catch(() => {}) }
        await Promise.allSettled(reads)
        if (timeoutTimer) clearTimeout(timeoutTimer)
        finishTask(record, exitCode)
      })().catch(() => finishTask(record, null))
      return toolResult(`Started background task ${record.taskId}. Use get_task_output to poll it.`, { raw: {
        kind: "bash", task_id: record.taskId, status: record.status, is_terminal: false, command, description,
        started_at: record.startedAt, spill_path: record.spillPath, raw_output_bytes: 0,
      } })
    }

    const stdoutReader = proc.stdout.getReader()
    const stderrReader = proc.stderr.getReader()
    const toolCallId = config?.toolCallId ?? config?.configurable?.toolCallId
    const progress = config?.configurable?.emitToolProgress
    let streamedBytes = 0
    let pending = ""
    let lastFlush = 0
    let flushTimer: ReturnType<typeof setTimeout> | undefined
    const flush = () => {
      flushTimer = undefined
      if (!pending || !toolCallId || typeof progress !== "function") return
      const chunk = pending; pending = ""; lastFlush = Date.now()
      progress(toolCallId, chunk)
    }
    const emitChunk = (chunk: string) => {
      if (!toolCallId || typeof progress !== "function" || streamedBytes >= 32 * 1024) return
      const allowed = Math.min(Buffer.byteLength(chunk), 32 * 1024 - streamedBytes)
      if (allowed <= 0) return
      const part = allowed === Buffer.byteLength(chunk) ? chunk : Buffer.from(chunk).subarray(0, allowed).toString()
      streamedBytes += Buffer.byteLength(part); pending += part
      const wait = Math.max(0, 100 - (Date.now() - lastFlush))
      if (!wait) flush(); else if (!flushTimer) flushTimer = setTimeout(flush, wait)
    }

    let timedOut = false
    let timer: ReturnType<typeof setTimeout> | undefined
    if (timeout && timeout > 0) {
      timer = setTimeout(() => {
        timedOut = true
        terminateProcessTree(proc.pid)
        // A shell can exit after backgrounding a compound command, leaving an
        // orphan with the pipe open. There is then no descendant left to find
        // at timeout, so stop waiting on our side as well.
        void stdoutReader.cancel()
        void stderrReader.cancel()
      }, timeout * 1000)
    }

    const stdoutPromise = readPipe(stdoutReader, emitChunk)
    const stderrPromise = readPipe(stderrReader, emitChunk)

    // A backgrounded child (`server & ...`) inherits the pipes, so EOF may never
    // arrive even though the shell has exited. Wait for exit first, then give
    // trailing foreground output a short grace window before cancelling the
    // readers (cancel resolves the pending read, keeping everything read so far).
    const exitCode = await proc.exited
    let detached = false
    const grace = setTimeout(() => {
      detached = true
      void stdoutReader.cancel()
      void stderrReader.cancel()
    }, 1500)
    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise])
    if (flushTimer) clearTimeout(flushTimer)
    flush()
    clearTimeout(grace)
    if (timer) clearTimeout(timer)

    let combined = stdout
    if (stderr) combined += (combined && !combined.endsWith("\n") ? "\n" : "") + stderr

    const { content, truncated, originalLines, reducer } = compressBashOutput(command, combined)
    let out = content
    let spillPath: string | undefined

    // Spill when we dropped content (size cap OR reducer) so the model can recover.
    // Compare against the raw combined output — if cleanup alone shortened it but
    // nothing meaningful was lost (ANSI only), still fine to skip spill when equal
    // enough; we spill whenever `truncated` is set by compress.
    if (truncated && combined.length > 0 && content.length < combined.length) {
      const { sessionForThread } = await import("../thread-context.ts")
      const owner = sessionForThread(threadId)
      const tmp = isIncognitoSession(owner ?? "")
        ? join(tmpdir(), "chunky-incognito", `chunky-bash-${Date.now()}-${randomBytes(4).toString("hex")}.txt`)
        : join(tmpdir(), `chunky-bash-${Date.now()}-${randomBytes(4).toString("hex")}.txt`)
      if (isIncognitoSession(owner ?? "")) mkdirSync(join(tmpdir(), "chunky-incognito"), { recursive: true })
      spillPath = tmp
      writeFileSync(tmp, combined, "utf-8")
      const bits = [`full output: ${tmp}`]
      if (originalLines > 0) bits.unshift(`kept compressed view of ${originalLines} lines`)
      if (reducer) bits.push(`reducer=${reducer}`)
      out += `\n\n[Output truncated. ${bits.join(" · ")}. Re-read with read/rg if you need more.]`
    }

    const status = timedOut ? `${exitCode} (timed out after ${timeout}s)` : String(exitCode)
    const note = detached && !timedOut
      ? "\n[note: a background process is still running and holding the output pipe; its further output is not captured]"
      : ""
    const dateStamp = dateStampFor(config?.configurable?.thread_id)
    const promptText = `${out ? `${out}\n` : ""}[exit code: ${status}]${note}${dateStamp}`
    return toolResult(promptText, { raw: {
      kind: "bash", command, exitCode, timedOut, truncated, originalLines, reducer,
      rawBytes: Buffer.byteLength(combined), ...(spillPath ? { spillPath } : {}), ...(detached ? { detached: true } : {}),
    } })
  },
  {
    name: "bash",
    description: `Run a shell command in the project root; this is how you list, search (grep/rg), and find files. Combines stdout+stderr, compresses noisy tool output (git/gh/npm/tsc/tests), signal-truncates to ~${MAX_LINES} lines / ${MAX_BYTES / 1000}KB (full output spilled to a temp file). Optional timeout in seconds. For dev servers use background=true with ready_pattern to be notified once ready; use monitor for ongoing watching.`,
    schema: z.object(bashInputShape),
  },
)
