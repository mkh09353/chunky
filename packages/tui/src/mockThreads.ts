// A fake THREADED agent run so the multi-thread TUI view can be demoed with no
// server/model. Emits a main thread that spawns a child thread which itself
// spawns a grandchild — exercising thread.spawn / thread.status and threadId-
// tagged message/tool events, i.e. the exact wire the real ThreadManager emits.
//
// Lives in the TUI package (NOT protocol/mock.ts) per the build contract.
import type { AgentEvent } from "@mc/protocol"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function* chunks(s: string): Generator<string> {
  for (const p of s.split(/(\s+)/)) if (p) yield p
}

export async function* mockThreadsRun(userText: string): AsyncGenerator<AgentEvent> {
  const sessionId = "mock-session"
  const child = "thr-explore"
  const grandchild = "thr-count"

  yield { type: "session.status", sessionId, status: "running" }

  // --- main thread opening ---
  yield { type: "message.start", role: "assistant" }
  for (const c of chunks(`On it: "${userText}". I'll delegate the exploration to a child thread.`)) {
    yield { type: "message.delta", text: c }
    await sleep(16)
  }
  yield { type: "message.end" }

  // --- spawn child thread: "Explore project" ---
  yield { type: "thread.spawn", threadId: child, parentThreadId: null, title: "Explore project" }
  yield { type: "thread.status", threadId: child, status: "running", title: "Explore project" }

  yield { type: "message.start", role: "assistant", threadId: child }
  for (const c of chunks("Let me list the working directory.")) {
    yield { type: "message.delta", text: c, threadId: child }
    await sleep(16)
  }
  yield { type: "message.end", threadId: child }

  yield { type: "tool.start", id: "c_tool_1", name: "list_dir", input: { path: "." }, threadId: child }
  await sleep(320)
  yield {
    type: "tool.end",
    id: "c_tool_1",
    ok: true,
    output: "package.json\nsrc/\nREADME.md",
    threadId: child,
  }

  // --- child spawns a grandchild: recursion ---
  yield { type: "thread.spawn", threadId: grandchild, parentThreadId: child, title: "Count source files" }
  yield { type: "thread.status", threadId: grandchild, status: "running", title: "Count source files" }

  yield { type: "message.start", role: "assistant", threadId: grandchild }
  for (const c of chunks("Counting files under src/…")) {
    yield { type: "message.delta", text: c, threadId: grandchild }
    await sleep(16)
  }
  yield { type: "tool.start", id: "g_tool_1", name: "list_dir", input: { path: "src" }, threadId: grandchild }
  await sleep(300)
  yield { type: "tool.end", id: "g_tool_1", ok: true, output: "App.tsx\ntranscript.ts\ntheme.ts", threadId: grandchild }
  for (const c of chunks(" Found 3 source files.")) {
    yield { type: "message.delta", text: c, threadId: grandchild }
    await sleep(16)
  }
  yield { type: "message.end", threadId: grandchild }
  yield { type: "thread.status", threadId: grandchild, status: "idle", title: "Count source files" }

  // --- child wraps up and closes ---
  yield { type: "message.start", role: "assistant", threadId: child }
  for (const c of chunks("Explore done: a Bun project with 3 source files.")) {
    yield { type: "message.delta", text: c, threadId: child }
    await sleep(16)
  }
  yield { type: "message.end", threadId: child }
  yield { type: "thread.status", threadId: child, status: "idle", title: "Explore project" }

  // --- main thread summary ---
  yield { type: "message.start", role: "assistant" }
  for (const c of chunks(
    "\n\nBoth threads finished. Summary: a Bun project with a src/ of 3 files. Want me to scaffold the next step?",
  )) {
    yield { type: "message.delta", text: c }
    await sleep(18)
  }
  yield { type: "message.end" }

  yield { type: "session.status", sessionId, status: "idle" }
}
