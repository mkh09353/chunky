import { afterEach, describe, expect, test } from "bun:test"

const { registerProvider } = await import("./providers/registry.ts")
const { setReview } = await import("./settings.ts")
const { ThreadManager } = await import("./threads.ts")
const { peekTaskReminders } = await import("./tasks.ts")
const { resetTasks } = await import("./tasks.ts")
const { installBackgroundDispatcher, resetBackgroundDispatcher } = await import("./background-dispatch.ts")

registerProvider({
  id: "review-test", label: "Review Test", billing: "unknown",
  ready: () => true,
  listModels: async () => [{ id: "reviewer", name: "Reviewer", reasoning: false }],
  buildModel: () => { throw new Error("unused") },
})

describe("review", () => {
  afterEach(async () => { await resetTasks(); resetBackgroundDispatcher() })

  function launchCompletedReview(rootId: string) {
    setReview({ enabled: true, provider: "review-test", model: "reviewer" })
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let seenThread = ""
    const fakeReviewAgent = () => ({ stream: async (_input: unknown, config: any) => {
      seenThread = config.configurable.thread_id
      await gate
      return (async function* () {
        yield ["messages", [{ type: "ai", content: "No issues found", response_metadata: { finish_reason: "stop" } }, {}]]
      })()
    } })
    const manager = new ThreadManager(() => {}, rootId, { provider: "review-test", model: "executor" }, undefined, undefined, "/tmp", undefined, undefined, fakeReviewAgent)
    const result = manager.launchReview({ callerThreadId: rootId, brief: "Review the diff" })
    return { gate, manager, release: () => release(), result, seenThread: () => seenThread }
  }

  test("launches detached and wakes an idle lead with actionable findings", async () => {
    const wakes: Array<{ id: string; prompt: string; shown: string; from?: string }> = []
    installBackgroundDispatcher({ isRunning: () => false, wake: (id, prompt, shown, from) => wakes.push({ id, prompt, shown, from }), changed: () => {} })
    const review = launchCompletedReview("review-idle")
    const { manager, result } = review
    expect(result).toContain("review launched:")
    // An async function runs synchronously until its first await, so the fake
    // records its fresh review thread before launchReview returns. What matters
    // is that launchReview does not wait for the gated completion.
    expect(review.seenThread()).toContain(":review:")
    review.release()
    for (let i = 0; i < 20 && wakes.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 5))
    expect(wakes).toHaveLength(1)
    expect(wakes[0]).toMatchObject({ id: "review-idle", shown: "Review finished; assess the findings before finalizing.", from: "review" })
    expect(wakes[0]?.prompt).toContain("No issues found")
    expect(wakes[0]?.prompt).toContain("fix any valid issues before finalizing")
    expect(peekTaskReminders("review-idle").text).toBe("")
    manager.dispose()
  })

  test("queues the established reminder while the lead is busy", async () => {
    installBackgroundDispatcher({ isRunning: () => true, wake: () => { throw new Error("busy session must not wake") }, changed: () => {} })
    const review = launchCompletedReview("review-busy")
    review.release()
    for (let i = 0; i < 20 && !peekTaskReminders("review-busy").text; i++) await new Promise((resolve) => setTimeout(resolve, 5))
    expect(peekTaskReminders("review-busy").text).toContain("Findings:\nNo issues found")
    review.manager.dispose()
  })
})
