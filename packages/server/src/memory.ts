import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import type { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { isIncognitoSession } from "./incognito.ts"
import { sidekickFor, resolveModel, type AgentSelection } from "./providers/registry.ts"
import { repoId, stateDir } from "./repos.ts"
import { Store } from "./store.ts"
import { coalesceRecallDeltas, renderRecallEvents } from "./tools/recall.ts"

export const MAX_TRANSCRIPT_BYTES = 48_000
const MAX_SESSIONS = 6
const MAX_MEMORY_LINES = 150
const DREAM_SYSTEM = `Rewrite the repository memory from the existing memory and recent transcripts. Keep only durable, actionable lessons for future coding work in this repository. Correct wrong entries, generalize tactical notes into durable rules, and prune stale or duplicate items. Return only free-form markdown, under ${MAX_MEMORY_LINES} lines. Do not add a heading merely for structure; preserve useful existing structure if any. If there is nothing worth retaining, return an empty response.`

type Invoke = (model: BaseChatModel, messages: Array<{ role: "system" | "user"; content: string }>) => Promise<unknown>
let invokeModel: Invoke = async (model, messages) => model.invoke(messages)
export function setDreamInvokerForTests(invoker: Invoke | null): void { invokeModel = invoker ?? (async (model, messages) => model.invoke(messages)) }

/** Match AGENTS.md's repository identity: a nested workspace belongs to its git root. */
export function memoryRepoRoot(workspace: string): string {
  let dir = resolve(workspace)
  const start = dir
  while (true) {
    if (existsSync(join(dir, ".git"))) return dir
    const parent = dirname(dir)
    if (parent === dir) return start
    dir = parent
  }
}
export function memoryRepoKey(workspace: string): string { return repoId(memoryRepoRoot(workspace)) }
export function memoryPath(workspace: string): string { return join(stateDir(), "memory", `${memoryRepoKey(workspace)}.md`) }

export function readRepoMemory(workspace: string, sessionId?: string): string | null {
  if (sessionId && isIncognitoSession(sessionId)) return null
  try { const text = readFileSync(memoryPath(workspace), "utf8").trim(); return text || null } catch { return null }
}

/** Atomic replacement protects the old memory if the process crashes mid-write. */
export function writeRepoMemory(workspace: string, text: string, sessionId?: string): boolean {
  if (sessionId && isIncognitoSession(sessionId)) return false
  const path = memoryPath(workspace)
  const clean = text.trim()
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, clean ? `${clean}\n` : "")
  renameSync(tmp, path)
  return true
}

export function appendRepoMemory(workspace: string, text: string, sessionId?: string): boolean {
  const lesson = text.trim()
  if (!lesson || (sessionId && isIncognitoSession(sessionId))) return false
  const prior = readRepoMemory(workspace, sessionId)
  return writeRepoMemory(workspace, prior ? `${prior}\n${lesson}` : lesson, sessionId)
}

function textOf(value: unknown): string {
  const content = (value as { content?: unknown })?.content
  if (typeof content === "string") return content
  if (Array.isArray(content)) return content.map((x) => typeof x === "string" ? x : (x as any)?.text ?? "").join("")
  return typeof value === "string" ? value : ""
}
function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text
  let end = 0
  let bytes = 0
  for (const char of text) {
    const size = Buffer.byteLength(char)
    if (bytes + size > maxBytes) break
    bytes += size
    end += char.length
  }
  return text.slice(0, end)
}
function cappedTranscript(workspace: string): string {
  const sessions = Store.list().filter((s) => !s.incognito && memoryRepoKey(s.workspace) === memoryRepoKey(workspace)).slice(0, MAX_SESSIONS)
  const parts: string[] = []
  let bytes = 0
  for (const session of sessions) {
    const rendered = renderRecallEvents(coalesceRecallDeltas(Store.historyWithSeq(session.sessionId)), false)
    const part = `Session ${session.sessionId} (${session.title}):\n${rendered}`
    const separatorBytes = parts.length ? Buffer.byteLength("\n\n") : 0
    const partBytes = Buffer.byteLength(part)
    if (bytes + separatorBytes + partBytes > MAX_TRANSCRIPT_BYTES) {
      const remaining = MAX_TRANSCRIPT_BYTES - bytes - separatorBytes
      if (remaining > 0) parts.push(truncateUtf8(part, remaining))
      break
    }
    parts.push(part); bytes += separatorBytes + partBytes
  }
  return parts.join("\n\n")
}
const lastTranscriptHash = new Map<string, string>()
const dreaming = new Set<string>()
export function dreamIsRunning(workspace: string): boolean { return dreaming.has(memoryRepoKey(workspace)) }

/** Consolidate memory for a normal repo. Returns false when no meaningful new transcript exists. */
export async function dreamRepoMemory(workspace: string, selection: AgentSelection, sessionId?: string, force = false): Promise<boolean> {
  if (sessionId && isIncognitoSession(sessionId)) return false
  const key = memoryRepoKey(workspace)
  if (dreaming.has(key)) return false
  const transcript = cappedTranscript(workspace)
  const before = readRepoMemory(workspace) ?? ""
  const input = `Existing repository memory:\n${before || "(empty)"}\n\nRecent transcripts:\n${transcript || "(none)"}`
  const transcriptHash = createHash("sha256").update(transcript).digest("hex")
  if (!transcript || (!force && lastTranscriptHash.get(key) === transcriptHash)) return false
  dreaming.add(key)
  try {
    const cheap = sidekickFor(selection) ?? selection
    const result = await invokeModel(resolveModel(cheap, sessionId), [{ role: "system", content: DREAM_SYSTEM }, { role: "user", content: input }])
    const rewritten = textOf(result).trim().split("\n").slice(0, MAX_MEMORY_LINES).join("\n").trim()
    writeRepoMemory(workspace, rewritten, sessionId)
    lastTranscriptHash.set(key, transcriptHash)
    console.debug(`[@chunky/server] dreamed repo memory ${key}: ${Buffer.byteLength(before)} -> ${Buffer.byteLength(rewritten)} bytes`)
    return true
  } catch (err) {
    console.warn(`[@chunky/server] could not dream repo memory: ${(err as Error).message}`)
    return false
  } finally { dreaming.delete(key) }
}
