// Deterministic tests for inter-session messaging: the bus's deliver/queue/drain
// semantics (fake impl, no server), the sender envelope, Store.lastAssistantText
// reassembly, and the send_to_session tool's decision paths.
import { describe, expect, test, beforeEach } from "bun:test"
import { rmSync } from "node:fs"

// Point the Store at a throwaway db BEFORE anything imports it. In a full
// `bun test` run another file may have opened the Store first (module
// singleton), so the env can be ignored — every session id below carries a
// per-run RUN suffix to stay isolated no matter which db this lands in.
process.env.CHUNKY_DB ||= "/tmp/chunky-bus-test.db"
for (const suffix of ["", "-wal", "-shm"]) {
  try {
    rmSync("/tmp/chunky-bus-test.db" + suffix)
  } catch {
    /* not there yet */
  }
}
const RUN = crypto.randomUUID().slice(0, 8)

const { deliverToSession, drainQueue, installSessionBus, queuedCount, resetSessionBus, sessionIsRunning, MAX_QUEUED } =
  await import("./session-bus.ts")
const { sessionLabel, senderEnvelope, listSessionsTool, sendToSessionTool } = await import("./tools/sessions.ts")
const { Store } = await import("./store.ts")
const { registerThread } = await import("./thread-context.ts")

/** A controllable fake of index.ts's run machinery. */
function fakeImpl() {
  const runningSet = new Set<string>()
  const delivered: Array<{ sessionId: string; shown: string; from: string; prompt: string }> = []
  const events: Array<{ sessionId: string; ev: unknown }> = []
  let resolvers: Array<() => void> = []
  const impl = {
    emitUserMessage(sessionId: string, text: string, from: string) {
      delivered.push({ sessionId, shown: text, from, prompt: "" })
    },
    emitEvent(sessionId: string, ev: unknown) {
      events.push({ sessionId, ev })
    },
    dispatch(sessionId: string, text: string) {
      delivered[delivered.length - 1]!.prompt = text
      runningSet.add(sessionId)
      return new Promise<void>((r) => {
        resolvers.push(() => {
          runningSet.delete(sessionId)
          r()
        })
      })
    },
    isRunning(sessionId: string) {
      return runningSet.has(sessionId)
    },
  }
  const finishNextRun = async () => {
    const r = resolvers.shift()
    r?.()
    await Bun.sleep(0) // let .finally(drainQueue) run
  }
  return { impl, delivered, events, runningSet, finishNextRun }
}

describe("session bus", () => {
  beforeEach(() => resetSessionBus())

  test("idle target -> delivered now, done resolves when the run completes", async () => {
    const { impl, delivered, finishNextRun } = fakeImpl()
    installSessionBus(impl)
    const { delivered: how, done } = deliverToSession("t1", { prompt: "p", shown: "s", from: "f" })
    expect(how).toBe("now")
    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toMatchObject({ sessionId: "t1", shown: "s", from: "f", prompt: "p" })
    let resolved = false
    void done.then(() => (resolved = true))
    await Bun.sleep(0)
    expect(resolved).toBe(false)
    await finishNextRun()
    await done
  })

  test("busy target -> queued, drained in order after each run", async () => {
    const { impl, delivered, runningSet, finishNextRun } = fakeImpl()
    installSessionBus(impl)
    runningSet.add("t2") // target mid-turn
    expect(sessionIsRunning("t2")).toBe(true)
    const a = deliverToSession("t2", { prompt: "a", shown: "a", from: "f" })
    const b = deliverToSession("t2", { prompt: "b", shown: "b", from: "f" })
    expect(a.delivered).toBe("queued")
    expect(b.delivered).toBe("queued")
    expect(queuedCount("t2")).toBe(2)
    expect(delivered).toHaveLength(0)

    runningSet.delete("t2") // the user turn finished
    drainQueue("t2") // index.ts calls this from startRun.finally
    expect(delivered.map((d) => d.prompt)).toEqual(["a"])
    await finishNextRun() // a's run completes -> b auto-drains
    await a.done
    expect(delivered.map((d) => d.prompt)).toEqual(["a", "b"])
    await finishNextRun()
    await b.done
    expect(queuedCount("t2")).toBe(0)
  })

  test("queue is capped at MAX_QUEUED", () => {
    const { impl, runningSet } = fakeImpl()
    installSessionBus(impl)
    runningSet.add("t3")
    for (let i = 0; i < MAX_QUEUED; i++) deliverToSession("t3", { prompt: `${i}`, shown: `${i}`, from: "f" })
    expect(() => deliverToSession("t3", { prompt: "x", shown: "x", from: "f" })).toThrow(/queued messages/)
  })

  test("uninstalled bus throws (and reports not-running)", () => {
    expect(sessionIsRunning("nope")).toBe(false)
    expect(() => deliverToSession("nope", { prompt: "p", shown: "s", from: "f" })).toThrow(/not installed/)
  })
})

describe("sender formatting", () => {
  test("sessionLabel uses title when meaningful, short id otherwise", () => {
    expect(sessionLabel("0f3a21c9-aaaa-bbbb", "fix tests")).toBe("fix tests (0f3a21c9)")
    expect(sessionLabel("0f3a21c9-aaaa-bbbb", "New session")).toBe("0f3a21c9")
    expect(sessionLabel("0f3a21c9-aaaa-bbbb", null)).toBe("0f3a21c9")
  })

  test("senderEnvelope is the pi-compatible tagged JSON", () => {
    expect(senderEnvelope("abc", "t")).toBe(`\n\n<sender_info>{"sessionId":"abc","title":"t"}</sender_info>`)
    expect(senderEnvelope("abc", null)).toBe(`\n\n<sender_info>{"sessionId":"abc"}</sender_info>`)
  })
})

describe("Store.lastAssistantText", () => {
  test("reassembles the last completed main-thread assistant message", () => {
    const sid = `bus-last-text-${RUN}`
    Store.createSession(sid)
    Store.appendEvent(sid, { type: "message.start", role: "assistant" })
    Store.appendEvent(sid, { type: "message.delta", text: "first " })
    Store.appendEvent(sid, { type: "message.delta", text: "answer" })
    Store.appendEvent(sid, { type: "message.end" })
    // A child-thread message must NOT count.
    Store.appendEvent(sid, { type: "message.start", role: "assistant", threadId: "child" })
    Store.appendEvent(sid, { type: "message.delta", text: "child text", threadId: "child" })
    Store.appendEvent(sid, { type: "message.end", threadId: "child" })
    expect(Store.lastAssistantText(sid)).toBe("first answer")
    // A later main-thread message wins, even if the stream was cut mid-message.
    Store.appendEvent(sid, { type: "message.start", role: "assistant" })
    Store.appendEvent(sid, { type: "message.delta", text: "second" })
    expect(Store.lastAssistantText(sid)).toBe("second")
  })

  test("null when there is no assistant text", () => {
    const sid = `bus-no-text-${RUN}`
    Store.createSession(sid)
    expect(Store.lastAssistantText(sid)).toBeNull()
  })
})

describe("send_to_session tool", () => {
  const SELF = `bus-self-session-${RUN}`
  const TARGET = `bus-target-session-${RUN}`

  beforeEach(() => {
    resetSessionBus()
    if (!Store.exists(SELF)) Store.createSession(SELF, "sender work")
    if (!Store.exists(TARGET)) Store.createSession(TARGET, "receiver work")
    registerThread(SELF, {
      sessionId: SELF,
      spawn: async () => "",
      consultAdvisor: async () => "",
      delegateToSidekick: async () => "",
      runWorkflow: async () => "",
    })
  })

  test("delivers to an idle session with the sender envelope", async () => {
    const { impl, delivered } = fakeImpl()
    installSessionBus(impl)
    const out = (await sendToSessionTool.invoke(
      { session_id: TARGET, message: "please rebuild" },
      { configurable: { thread_id: SELF } },
    )) as string
    expect(out).toContain("Delivered")
    expect(delivered).toHaveLength(1)
    expect(delivered[0]!.shown).toBe("please rebuild")
    expect(delivered[0]!.prompt).toContain("please rebuild")
    expect(delivered[0]!.prompt).toContain(`<sender_info>{"sessionId":"${SELF}","title":"sender work"}</sender_info>`)
    expect(delivered[0]!.from).toContain("sender work")
  })

  test("queues behind a busy session and says so", async () => {
    const { impl, runningSet } = fakeImpl()
    installSessionBus(impl)
    runningSet.add(TARGET)
    const out = (await sendToSessionTool.invoke(
      { session_id: TARGET, message: "after you" },
      { configurable: { thread_id: SELF } },
    )) as string
    expect(out).toContain("Queued")
    expect(queuedCount(TARGET)).toBe(1)
  })

  test("refuses self-sends and unknown/ambiguous targets", async () => {
    const { impl } = fakeImpl()
    installSessionBus(impl)
    const self = (await sendToSessionTool.invoke(
      { session_id: SELF, message: "hi me" },
      { configurable: { thread_id: SELF } },
    )) as string
    expect(self).toContain("error:")
    const unknown = (await sendToSessionTool.invoke(
      { session_id: "totally-unknown", message: "hi" },
      { configurable: { thread_id: SELF } },
    )) as string
    expect(unknown).toContain("unknown session")
  })

  test("resolves an unambiguous id prefix", async () => {
    const { impl, delivered } = fakeImpl()
    installSessionBus(impl)
    const out = (await sendToSessionTool.invoke(
      { session_id: `bus-target-session-${RUN}`.slice(0, 24), message: "prefix ok" },
      { configurable: { thread_id: SELF } },
    )) as string
    expect(out).toContain("Delivered")
    expect(delivered[0]!.sessionId).toBe(TARGET)
  })

  test("wait_for_reply returns the target's final assistant text", async () => {
    const { impl, finishNextRun } = fakeImpl()
    installSessionBus(impl)
    const pending = sendToSessionTool.invoke(
      { session_id: TARGET, message: "what's the status?", wait_for_reply: true },
      { configurable: { thread_id: SELF } },
    ) as Promise<string>
    await Bun.sleep(0)
    Store.appendEvent(TARGET, { type: "message.start", role: "assistant" })
    Store.appendEvent(TARGET, { type: "message.delta", text: "all green" })
    Store.appendEvent(TARGET, { type: "message.end" })
    await finishNextRun()
    const out = await pending
    expect(out).toContain("all green")
  })
})

describe("list_sessions tool", () => {
  test("lists sessions with status and marks the caller", async () => {
    resetSessionBus()
    const { impl, runningSet } = fakeImpl()
    installSessionBus(impl)
    const SELF = `bus-self-session-${RUN}`
    const TARGET = `bus-target-session-${RUN}`
    if (!Store.exists(SELF)) Store.createSession(SELF, "sender work")
    if (!Store.exists(TARGET)) Store.createSession(TARGET, "receiver work")
    runningSet.add(TARGET)
    const out = (await listSessionsTool.invoke({}, { configurable: { thread_id: SELF } })) as string
    expect(out).toContain(SELF)
    expect(out).toContain("← this session")
    expect(out).toContain(`${TARGET}`)
    expect(out).toMatch(/bus-target-session.*running/)
  })
})
