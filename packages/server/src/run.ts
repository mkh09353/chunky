// Streaming translation: run the DeepAgents agent and translate LangGraph JS v1
// stream items into protocol AgentEvents. Verified empirically against GLM-5.2.
//
// The core translation lives in `translateStream(stream, threadId, emit)` so the
// SAME logic drives the main session run AND every spawned child thread (see
// threads.ts). Events are tagged with `threadId` for children; the main thread
// omits it (so the wire is identical to the pre-threads prototype).
import type { MessageEndReason, UsageDelta } from "@chunky/protocol"
import { getAgent, RECURSION_LIMIT } from "./agent.ts"
import { taggedEmitter, type Emit } from "./event-emitter.ts"
import { activeSelection, getProvider, providerRuntime } from "./providers/registry.ts"
import { ThreadManager } from "./threads.ts"
import { usageFromLangChainMessage, promptTokensOf } from "./usage.ts"
import { checkCacheCold, cacheWarningEvent, noteRequest } from "./cache-watch.ts"
import { Store } from "./store.ts"
import { LAUNCH_WORKSPACE } from "./workspace.ts"
import { classifyGoalError, decideGoalStep, firstLine, goalContinuationPrompt, toSnapshot, type GoalStep } from "./goal.ts"
import { distilledAgentsMd } from "./agents-md.ts"
import { asToolRunResult } from "./tools/result.ts"
import { pendingTaskReminders } from "./tasks.ts"

export type { Emit } from "./event-emitter.ts"

/** Tells a stream which conversation's prompt cache to keep warm. Only the main
 *  user-driven session carries one (child/advisor threads don't warn). */
export interface CacheContext {
  /** Conversation id whose cache we track (the main session id). */
  conversationId: string
  /** Model driving this turn — recorded so a later switch is detected. */
  model: string
}
export interface InterjectionBoundary {
  prompts: string[]
  texts: string[]
  images: (InputImage[] | undefined)[]
}

// Extract plain text from an AIMessageChunk `content`, which is either a string
// or an array of content blocks (we only care about text blocks).
function contentToText(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    let out = ""
    for (const part of content) {
      if (typeof part === "string") out += part
      else if (part && typeof part === "object") {
        const p = part as Record<string, unknown>
        if (p.type === "text" && typeof p.text === "string") out += p.text
      }
    }
    return out
  }
  return ""
}

function getType(msg: any): string {
  if (!msg || typeof msg !== "object") return ""
  if (typeof msg.getType === "function") return msg.getType()
  if (typeof msg._getType === "function") return msg._getType()
  return msg.type ?? ""
}

/**
 * Translate one LangGraph stream (streamMode ["updates","messages"]) into
 * AgentEvents, emitting message.start/delta/end for assistant text and
 * tool.start/tool.end for tool calls. Every emitted event is tagged with
 * `threadId` when one is supplied (child threads); pass `undefined` for the
 * main session thread to keep events untagged. Returns the accumulated
 * assistant text so a child thread can hand its final answer back to its caller.
 */
export async function translateStream(
  // The concrete LangGraph stream type is provider/graph-specific; we consume it
  // structurally as ["updates"|"messages", data] tuples.
  stream: AsyncIterable<unknown>,
  threadId: string | undefined,
  emit: Emit,
  cache?: CacheContext,
  onToolBoundary?: () => InterjectionBoundary | undefined,
): Promise<string> {
  // Tag message/tool/error events with the owning threadId (omitted for main).
  const emitT = taggedEmitter(emit, threadId)

  let assistantOpen = false
  let finalText = ""
  let sawAssistantOrTool = false
  const seenToolStart = new Set<string>()
  const seenToolEnd = new Set<string>()
  // Track the LAST LLM request's prompt size to feed the cache watch. Within a
  // tool loop later requests reuse the cache; it's the turn's final prompt that
  // approximates the live context that a cold cache would force us to re-send.
  // Providers report usage on the streamed chunk and/or the completed updates
  // message — prefer updates, fall back to the stashed chunk.
  let lastRequestUsage: UsageDelta | null = null
  let pendingChunkUsage: UsageDelta | null = null
  let pendingEndReason: MessageEndReason = "complete"

  const endReasonOf = (message: any): MessageEndReason => {
    const raw =
      message?.response_metadata?.finish_reason ??
      message?.response_metadata?.stop_reason ??
      message?.finish_reason
    return raw === "length" || raw === "max_tokens" || raw === "max_output_tokens" ? "max_tokens" : "complete"
  }

  const openAssistant = () => {
    if (!assistantOpen) {
      assistantOpen = true
      emitT({ type: "message.start", role: "assistant" })
    }
  }
  const closeAssistant = (reason: MessageEndReason = pendingEndReason) => {
    if (assistantOpen) {
      assistantOpen = false
      emitT({ type: "message.end", reason })
      pendingEndReason = "complete"
    }
  }

  try {
    for await (const item of stream as AsyncIterable<[string, unknown]>) {
      const [mode, data] = item

      if (mode === "messages") {
        // data === [messageChunk, metadata]
        const [chunk] = data as [any, unknown]
        if (getType(chunk) === "ai") {
          pendingEndReason = endReasonOf(chunk)
          const t = contentToText(chunk?.content)
          if (t) {
            sawAssistantOrTool = true
            openAssistant()
            finalText += t
            emitT({ type: "message.delta", text: t })
          }
          // Stash chunk usage; used only if the matching updates AI message
          // carries none of its own.
          const u = usageFromLangChainMessage(chunk)
          if (u && promptTokensOf(u) > 0) pendingChunkUsage = u
        }
        continue
      }

      if (mode === "updates") {
        // data === { nodeName: { messages?: BaseMessage[], ... }, ... }
        const updates = data as Record<string, any>
        if (!updates || typeof updates !== "object") continue
        for (const nodeUpdate of Object.values(updates)) {
          const messages = nodeUpdate?.messages
          if (!Array.isArray(messages)) continue
          for (const msg of messages) {
            const kind = getType(msg)
            if (kind === "ai") {
              // A completed assistant message closes any open streamed text turn.
              pendingEndReason = endReasonOf(msg)
              closeAssistant()
              const u = usageFromLangChainMessage(msg)
              if (u && promptTokensOf(u) > 0) {
                lastRequestUsage = u
                pendingChunkUsage = null
              } else if (pendingChunkUsage) {
                lastRequestUsage = pendingChunkUsage
                pendingChunkUsage = null
              }
              const toolCalls = msg?.tool_calls
              if (Array.isArray(toolCalls)) {
                for (const tc of toolCalls) {
                  const id = tc?.id ?? `${tc?.name}:${JSON.stringify(tc?.args)}`
                  if (seenToolStart.has(id)) continue
                  seenToolStart.add(id)
                  sawAssistantOrTool = true
                  emitT({
                    type: "tool.start",
                    id,
                    name: tc?.name ?? "unknown",
                    input: tc?.args ?? {},
                  })
                }
              }
            } else if (kind === "tool") {
              sawAssistantOrTool = true
              const id = msg?.tool_call_id ?? msg?.id ?? "unknown"
              if (seenToolEnd.has(id)) continue
              seenToolEnd.add(id)
              const result = asToolRunResult(
                msg?.artifact && typeof msg.artifact === "object"
                  ? msg.artifact
                  : typeof msg?.content === "string"
                    ? msg.content
                    : contentToText(msg?.content),
              )
              emitT({
                type: "tool.end",
                id,
                ok: result.ok && msg?.status !== "error",
                output: result.promptText,
                ...(result.raw !== undefined ? { raw: result.raw } : {}),
              })
              const interjection = threadId === undefined ? onToolBoundary?.() : undefined
              if (interjection !== undefined) throw Object.assign(new Error(JSON.stringify(interjection)), { name: "InterjectionBoundary" })
            }
          }
        }
        continue
      }
    }
  } catch (error) {
    // The coordinator deliberately uses an exception to leave the provider
    // iterator at a completed tool node. This is an internal continuation, not
    // an interruption/error visible to the user.
    const name = (error as Error)?.name
    closeAssistant(name === "AbortError" ? "interrupted" : name === "InterjectionBoundary" ? "complete" : "error")
    throw error
  } finally {
    closeAssistant()
    // Stream ended mid-message: the stashed chunk is then the last request.
    if (pendingChunkUsage) {
      lastRequestUsage = pendingChunkUsage
      pendingChunkUsage = null
    }
  }

  // Arm the cache watch with this turn's final prompt size so the NEXT turn can
  // tell whether the cache went cold (idle past the TTL or a model switch).
  // Record the SELECTION id (cache.model), not the provider-reported usage
  // model: checkCacheCold compares against the next turn's selection id, so
  // both sides must share that namespace — a provider-format id (or an aux
  // model's id) here manufactures a false "model switch" warning.
  if (cache && lastRequestUsage) {
    noteRequest(cache.conversationId, lastRequestUsage, cache.model, Date.now())
  }
  if (lastRequestUsage) emitT({ type: "usage.update", usage: lastRequestUsage })

  if (!sawAssistantOrTool) {
    throw new Error("provider returned an empty response — retry the turn or switch models")
  }

  return finalText
}

/** An image the user pasted (Ctrl+V), carried from the TUI as base64. */
export interface InputImage {
  base64: string
  mediaType: string
}

/** Pause the session's goal and announce it — but ONLY if it's currently active,
 *  so a terminal complete/blocked (or a no-goal session) is never clobbered by an
 *  interrupt/error race. Used on interrupt, error, and turn-budget exhaustion. */
function pauseGoal(sessionId: string, emit: Emit, message: string): void {
  const current = Store.getGoal(sessionId)
  if (!current || current.status !== "active") return
  const paused = Store.updateGoal(sessionId, { status: "paused" })
  if (paused) emit({ type: "goal.update", sessionId, goal: toSnapshot(paused), message })
}

/** Surface a non-continue goal outcome. complete/blocked announce the terminal
 *  state; budget/aborted pause-and-announce; no-goal/paused stay silent (a pause
 *  was already announced at the moment it happened). */
function emitGoalStop(sessionId: string, reason: Extract<GoalStep, { kind: "stop" }>["reason"], emit: Emit): void {
  const goal = Store.getGoal(sessionId)
  if (!goal) return
  switch (reason) {
    case "complete":
      emit({
        type: "goal.update",
        sessionId,
        goal: toSnapshot(goal),
        message: `✓ Goal complete${goal.evidence ? " — " + firstLine(goal.evidence) : ""}`,
      })
      return
    case "blocked":
      emit({
        type: "goal.update",
        sessionId,
        goal: toSnapshot(goal),
        message: `⛔ Goal blocked${goal.blockedReason ? " — " + firstLine(goal.blockedReason) : ""}`,
      })
      return
    case "budget":
      pauseGoal(sessionId, emit, `⏸ Goal paused — reached the ${goal.maxTurns}-turn budget. Use /goal resume to keep going.`)
      return
    case "aborted":
      pauseGoal(sessionId, emit, "⏸ Goal paused (interrupted). Use /goal resume to keep going.")
      return
    // "no-goal" and "paused": nothing to announce.
  }
}

/** Build the user message: a plain string when there are no images, or the
 *  OpenAI-style multimodal content array (text + image_url data-URIs) when there
 *  are — which LangChain ChatOpenAI forwards to vision models (Grok 4.5, GPT-5.5). */
export function userMessageContent(text: string, images?: InputImage[]): unknown {
  if (!images || images.length === 0) return text
  return [
    ...(text ? [{ type: "text", text }] : []),
    ...images.map((i) => ({ type: "image_url", image_url: { url: `data:${i.mediaType};base64,${i.base64}` } })),
  ]
}

/**
 * Run one agent turn for `text` on thread `sessionId`, emitting AgentEvents.
 * This is the MAIN session thread: its message/tool events are untagged, and it
 * installs a ThreadManager (registered under `sessionId`) so the model can call
 * the `spawn_thread` tool to launch real, independent, streamable child threads.
 * `images` are pasted attachments (Ctrl+V); ignored on the Anthropic-SDK path for now.
 */
export async function runAgent(
  sessionId: string,
  text: string,
  emit: Emit,
  images?: InputImage[],
  abort?: AbortController,
  options?: {
    /** Skip the turn-start cold-cache notice — the user already confirmed this
     *  re-send through the cache guard, so repeating the warning is noise. */
    suppressCacheWarning?: boolean
    onToolBoundary?: () => InterjectionBoundary | undefined
  },
): Promise<void> {
  emit({ type: "session.status", sessionId, status: "running" })
  const reminder = pendingTaskReminders(sessionId)
  if (reminder) text = `${text}\n\n[Background task reminders]\n${reminder}`

  // Freeze the root selection for this run. A later /model change affects the
  // next root turn, never an in-flight root or any of its child threads. A
  // session with a PINNED selection (a shipped goal-orchestrator keeping its
  // model) uses that instead — unless its provider has since been unregistered.
  const pinned = Store.pinnedSelectionOf(sessionId)
  const selection = pinned && getProvider(pinned.provider) ? pinned : activeSelection()

  // Freeze the run's workspace from the SESSION (not any global): every tool
  // call, child thread, and advisor consult in this run operates here, so
  // sessions in different repos run concurrently without interfering.
  const workspace = Store.workspaceOf(sessionId) ?? LAUNCH_WORKSPACE
  const agentsMd = await distilledAgentsMd(workspace, selection)

  // Preflight credentials: refresh an expiring OAuth token, or fail fast with a
  // clear "run /login" error. Without this a revoked token hangs the whole turn
  // inside the streaming request (the error is swallowed by the stream).
  try {
    await getProvider(selection.provider)?.ensureAuth?.()
  } catch (err) {
    const detail = (err as Error)?.message ?? String(err)
    emit({
      type: "error",
      message: `${selection.provider}: sign-in expired — run /login to re-authenticate. (${detail})`,
    })
    emit({ type: "session.status", sessionId, status: "idle" })
    return
  }

  // Before spending anything, warn if this thread's prompt cache went cold since
  // the last turn (idle past the TTL, or a model switch) — a cue to start fresh.
  // Only meaningful when the model is known (needed to detect a switch).
  const model = selection.model
  if (model && !options?.suppressCacheWarning) {
    const cold = checkCacheCold(sessionId, model, Date.now())
    if (cold) emit(cacheWarningEvent(sessionId, cold))
  }

  // Context for spawn_thread: any thread_id in this run (root or descendant)
  // resolves back to this manager via the thread registry. Defaults for the
  // agent factories; the workspace pins children to the session's repo.
  const threads = new ThreadManager(emit, sessionId, selection, undefined, undefined, workspace, abort)
  const cache: CacheContext | undefined = model ? { conversationId: sessionId, model } : undefined

  // One turn = one full agent run (a model call + any tool loop). Both runtimes
  // reduce to this; goal mode just calls it repeatedly with continuation nudges.
  const runTurn = async (prompt: string, turnImages?: InputImage[]): Promise<void> => {
    if (providerRuntime(selection.provider) === "anthropic-sdk") {
      const { runAnthropicAgent } = await import("./anthropic-runner.ts")
      await runAnthropicAgent({ selection, threadId: sessionId, prompt, emit, cache, abort, workspace, agentsMd })
    } else {
      const stream = await getAgent(selection, workspace, agentsMd).stream(
        { messages: [{ role: "user", content: userMessageContent(prompt, turnImages) }] } as any,
        {
          configurable: { thread_id: sessionId, workspace },
          streamMode: ["updates", "messages"],
          recursionLimit: RECURSION_LIMIT,
          signal: abort?.signal,
        } as any,
      )

      await translateStream(stream, undefined, emit, cache, options?.onToolBoundary)
    }
  }

  try {
    let prompt = text
    let pendingInterjections: InterjectionBoundary = { prompts: [], texts: [], images: [] }
    let turnImages = images
    // Goal-mode continuation loop. With NO goal this runs exactly once
    // (decideGoalStep → "no-goal" → break) — identical to the pre-goal behavior.
    // With an active goal it keeps injecting hidden continuation nudges until the
    // model calls goal_complete/goal_blocked, the run is interrupted, or the turn
    // budget is spent.
    while (true) {
      try { await runTurn(prompt, turnImages) } catch (err) {
        if ((err as Error)?.name === "InterjectionBoundary") {
          const boundary = JSON.parse((err as Error).message) as InterjectionBoundary
          pendingInterjections = boundary
          prompt = pendingInterjections.prompts.shift() ?? prompt
          turnImages = pendingInterjections.images.shift()
          const note = pendingInterjections.texts.shift()
          if (note !== undefined) emit({ type: "message.interjection", sessionId, text: note, injected: true })
          continue
        }
        throw err
      }
      turnImages = undefined // pasted images ride only the first turn

      if (pendingInterjections.prompts.length) {
        prompt = pendingInterjections.prompts.shift()!
        turnImages = pendingInterjections.images.shift()
        const note = pendingInterjections.texts.shift()!
        emit({ type: "message.interjection", sessionId, text: note, injected: true })
        continue
      }

      const step = decideGoalStep(Store.getGoal(sessionId), abort?.signal.aborted ?? false)
      if (step.kind === "stop") {
        emitGoalStop(sessionId, step.reason, emit)
        break
      }
      const updated = Store.updateGoal(sessionId, { turns: step.nextTurn })
      if (!updated) break // goal was cleared mid-flight
      emit({
        type: "goal.update",
        sessionId,
        goal: toSnapshot(updated),
        message: `↻ Goal continuing — turn ${updated.turns}/${updated.maxTurns}`,
      })
      prompt = goalContinuationPrompt(updated)
    }
  } catch (err) {
    // A user interrupt aborts the stream — report it as a calm stop, not an error.
    // Either way, pause an active goal so it never silently resumes on a later
    // unrelated message; /goal resume restarts it deliberately.
    if (abort?.signal.aborted || (err as Error)?.name === "AbortError") {
      // A STEER abort (reason "steer") is a course-correction, not a stop: the
      // superseding turn is already starting, so stay quiet and leave the goal
      // running — the steer message continues the work.
      if (abort?.signal.reason !== "steer") {
        emit({ type: "error", message: "⏹ Interrupted." })
        pauseGoal(sessionId, emit, "⏸ Goal paused (interrupted). Use /goal resume to keep going.")
      }
    } else {
      const message = (err as Error)?.message ?? String(err)
      emit({ type: "error", message })
      // Usage/rate-limit failures are "resume later", not "something broke" —
      // the distinction sets the right expectation in the pause marker.
      pauseGoal(
        sessionId,
        emit,
        classifyGoalError(message) === "usage-limit"
          ? "⏸ Goal paused — hit a usage/rate limit. Use /goal resume once limits clear."
          : "⏸ Goal paused after an error. Use /goal resume to retry.",
      )
    }
  } finally {
    threads.dispose()
    emit({ type: "session.status", sessionId, status: "idle" })
  }
}
