// Inter-session tools: list the other live sessions on this server and send
// one a message. The Pi "control" extension needs Unix sockets for this; here
// every session already lives in one server process, so it's a Store read plus
// the session-bus (see session-bus.ts for delivery semantics).
import { tool } from "@langchain/core/tools"
import { z } from "zod"
import { basename } from "node:path"
import { Store } from "../store.ts"
import { sessionForThread } from "../thread-context.ts"
import { busInstalled, deliverToSession, queuedCount, sessionIsRunning } from "../session-bus.ts"
import { firstLine } from "../goal.ts"

function threadIdOf(config: unknown): string | undefined {
  return (config as any)?.configurable?.thread_id as string | undefined
}

function shortId(sessionId: string): string {
  return sessionId.slice(0, 8)
}

/** Short human label for a session: `fix tests (0f3a21c9)`. */
export function sessionLabel(sessionId: string, title: string | null): string {
  const t = (title ?? "").trim()
  return t && t !== "New session" ? `${t.slice(0, 60)} (${shortId(sessionId)})` : shortId(sessionId)
}

/** The sender envelope appended to the delivered prompt, so the receiving model
 *  knows who sent it and can reply via send_to_session. Same format as Pi's. */
export function senderEnvelope(sessionId: string, title: string | null): string {
  return `\n\n<sender_info>${JSON.stringify({ sessionId, title: title ?? undefined })}</sender_info>`
}

/** How long wait_for_reply blocks before giving up (the target keeps working). */
const WAIT_TIMEOUT_MS = 5 * 60_000

export const listSessionsTool = tool(
  async (_input: Record<string, never>, config?: unknown) => {
    const selfId = sessionForThread(threadIdOf(config))
    const sessions = Store.list()
    if (sessions.length === 0) return "No sessions found."
    const lines = sessions.map((s) => {
      const parts = [`- ${s.sessionId}`]
      if (s.title && s.title !== "New session") parts.push(`"${s.title.slice(0, 60)}"`)
      const workspace = Store.workspaceOf(s.sessionId)
      if (workspace) parts.push(`repo: ${basename(workspace)}`)
      parts.push(sessionIsRunning(s.sessionId) ? "running" : "idle")
      const queued = queuedCount(s.sessionId)
      if (queued > 0) parts.push(`${queued} queued`)
      const goal = Store.getGoal(s.sessionId)
      if (goal) parts.push(`goal ${goal.status}: ${firstLine(goal.objective)}`)
      if (s.sessionId === selfId) parts.push("← this session")
      return parts.join(" · ")
    })
    return `Sessions on this server (newest first):\n${lines.join("\n")}`
  },
  {
    name: "list_sessions",
    description:
      "List the sessions on this Chunky server — id, title, repo, running/idle, queued messages, and any active " +
      "goal. Use it to discover a session before send_to_session. The current session is marked.",
    schema: z.object({}),
  },
)

export const sendToSessionInputShape = {
  session_id: z.string().describe("Target session id (from list_sessions). Prefix match is accepted if unambiguous."),
  message: z
    .string()
    .describe(
      "The message to deliver. It arrives as a user-style message in the target session, tagged with this " +
        "session's id/title so the target can reply via send_to_session.",
    ),
  wait_for_reply: z
    .boolean()
    .optional()
    .describe(
      "Wait (up to 5 minutes) for the target to finish the turn your message triggers, and return its final " +
        "assistant message. Default false: deliver and return immediately. Don't combine with asking the target " +
        "to reply via send_to_session — pick one.",
    ),
}

export const sendToSessionTool = tool(
  async (
    { session_id, message, wait_for_reply }: { session_id: string; message: string; wait_for_reply?: boolean },
    config?: unknown,
  ) => {
    if (!busInstalled()) return "error: inter-session messaging is not available in this run."
    const selfId = sessionForThread(threadIdOf(config))
    const text = message.trim()
    if (!text) return "error: empty message."

    // Resolve the target: exact id, or unambiguous prefix.
    let targetId = session_id.trim()
    if (!Store.exists(targetId)) {
      const matches = Store.list()
        .map((s) => s.sessionId)
        .filter((id) => id.startsWith(targetId))
      if (matches.length === 1) targetId = matches[0]!
      else if (matches.length > 1) return `error: session id "${session_id}" is ambiguous (${matches.length} matches).`
      else return `error: unknown session "${session_id}" — call list_sessions for live ids.`
    }
    if (targetId === selfId) {
      return "error: that is this session. Messaging yourself would just queue a turn behind this one — do the work here instead."
    }

    const fromLabel = selfId ? sessionLabel(selfId, Store.titleOf(selfId)) : "unknown session"
    const targetLabel = sessionLabel(targetId, Store.titleOf(targetId))
    const prompt = text + (selfId ? senderEnvelope(selfId, Store.titleOf(selfId)) : "")

    let delivery: { delivered: "now" | "queued"; done: Promise<void> }
    try {
      delivery = deliverToSession(targetId, { prompt, shown: text, from: fromLabel })
    } catch (err) {
      return `error: ${(err as Error).message}`
    }

    if (!wait_for_reply) {
      return delivery.delivered === "now"
        ? `Delivered to session ${targetLabel} — it started a turn on your message.`
        : `Queued for session ${targetLabel} — it is mid-turn; your message runs when the current turn finishes.`
    }

    const timedOut = await Promise.race([
      delivery.done.then(() => false),
      new Promise<true>((r) => setTimeout(r, WAIT_TIMEOUT_MS, true)),
    ])
    if (timedOut) {
      return `Delivered to session ${targetLabel}, but its turn is still running after 5 minutes. Check back with list_sessions / send_to_session later.`
    }
    const reply = Store.lastAssistantText(targetId)
    return reply
      ? `Session ${targetLabel} finished the turn. Its reply:\n\n${reply}`
      : `Session ${targetLabel} finished the turn but produced no assistant text.`
  },
  {
    name: "send_to_session",
    description:
      "Send a message to ANOTHER session on this Chunky server (find ids with list_sessions) — e.g. to hand off a " +
      "follow-up task, notify a session working in a different repo, or ask it a question. Delivery: an idle " +
      "session starts a turn on your message immediately; a busy one processes it after its current turn. The " +
      "message carries this session's id so the target can reply with send_to_session. Use wait_for_reply to get " +
      "its answer synchronously. Do NOT relay messages back and forth without new information — no ping-pong.",
    schema: z.object(sendToSessionInputShape),
  },
)

export const sessionTools = [listSessionsTool, sendToSessionTool]
