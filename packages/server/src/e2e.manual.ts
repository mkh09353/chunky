// End-to-end (best-effort): create a session, open the SSE stream, POST a message
// that asks the agent to use spawn_thread, and print every event — highlighting
// thread.* and threadId-tagged child events flowing over the SINGLE session SSE.
//
// Assumes the server is already listening on MC_PORT/4599.
// Run:  bun run packages/server/src/e2e.manual.ts
import { DEFAULT_PORT, ROUTES, readSSE, type AgentEvent } from "@mc/protocol"

const base = `http://localhost:${process.env.MC_PORT || DEFAULT_PORT}`

const res = await fetch(base + ROUTES.createSession, { method: "POST" })
const { sessionId } = (await res.json()) as { sessionId: string }
console.log(`session ${sessionId}`)

const seen: AgentEvent[] = []
const evRes = await fetch(base + ROUTES.events(sessionId))

// Consume the SSE in the background.
const reader = (async () => {
  for await (const ev of readSSE(evRes)) {
    seen.push(ev)
    if (ev.type === "thread.spawn") {
      console.log(`  >> thread.spawn threadId=${ev.threadId} parent=${ev.parentThreadId} title="${ev.title}"`)
    } else if (ev.type === "thread.status") {
      console.log(`  >> thread.status ${ev.status} threadId=${ev.threadId}`)
    } else if (ev.type === "tool.start" && (ev as any).threadId) {
      console.log(`  >> [child ${(ev as any).threadId.slice(0, 8)}] tool.start ${ev.name}`)
    } else if (ev.type === "message.delta" && (ev as any).threadId) {
      process.stdout.write(".")
    }
  }
})()

await fetch(base + ROUTES.sendMessage(sessionId), {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    text: "Use the spawn_thread tool to list the current directory in a child thread, then summarize what the child found in one sentence.",
  }),
})

// Wait until the session goes idle after having run, or time out.
const started = Date.now()
while (Date.now() - started < 90_000) {
  await new Promise((r) => setTimeout(r, 500))
  const idle = seen.some((e) => e.type === "session.status" && e.status === "idle")
  const ran = seen.some((e) => e.type === "session.status" && e.status === "running")
  if (ran && idle) break
}

console.log("\n\n--- summary ---")
const spawns = seen.filter((e) => e.type === "thread.spawn")
const childTagged = seen.filter(
  (e) =>
    (e.type === "message.delta" || e.type === "tool.start" || e.type === "tool.end") &&
    (e as any).threadId,
)
console.log(`thread.spawn events: ${spawns.length}`)
console.log(`threadId-tagged child events: ${childTagged.length}`)
for (const s of spawns) {
  if (s.type === "thread.spawn") console.log(`  spawned child ${s.threadId} title="${s.title}"`)
}
if (spawns.length > 0 && childTagged.length > 0) {
  console.log("E2E PASS: model spawned a real child thread that streamed over the session SSE")
} else {
  console.log("E2E NOTE: model did not call spawn_thread this run (model-dependent; deterministic test proves the path)")
}
process.exit(0)
