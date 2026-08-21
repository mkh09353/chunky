import { expect, test } from "bun:test"
import {
  DELEGATE_TRANSPORT_RETRY_PROMPT,
  isTransientDelegateFailure,
  shouldRetryDelegate,
  transientFailureReason,
} from "./transient-failure.ts"

const liveDog = { timedOut: () => false, abort: { signal: { aborted: false } } }
const timedOutDog = { timedOut: () => true, abort: { signal: { aborted: true } } }
const parentAbortedDog = { timedOut: () => false, abort: { signal: { aborted: true } } }

test("watchdog timeout is transient", () => {
  expect(isTransientDelegateFailure(new Error("The operation was aborted"), timedOutDog)).toBe(true)
  expect(transientFailureReason(new Error("aborted"), timedOutDog)).toBe("inactivity watchdog")
})

test("empty completion is transient and walks the cause chain", () => {
  expect(isTransientDelegateFailure(new Error("Received empty response from chat model call."), liveDog)).toBe(true)
  expect(isTransientDelegateFailure(new Error("provider returned an empty response — retry the turn"), liveDog)).toBe(true)
  expect(isTransientDelegateFailure(new Error("run failed", {
    cause: new Error("Received empty response from chat model call."),
  }), liveDog)).toBe(true)
  expect(transientFailureReason(new Error("Received empty response from chat model call."))).toBe("empty response")
})

test("socket and fetch drops are transient", () => {
  expect(isTransientDelegateFailure(new Error("The socket connection was closed unexpectedly"), liveDog)).toBe(true)
  expect(isTransientDelegateFailure(new Error("TypeError: fetch failed"), liveDog)).toBe(true)
  expect(isTransientDelegateFailure(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }), liveDog)).toBe(true)
  expect(isTransientDelegateFailure(new Error("other side terminated"), liveDog)).toBe(true)
  expect(isTransientDelegateFailure(new Error("Premature close"), liveDog)).toBe(true)
  expect(transientFailureReason(new Error("The socket connection was closed unexpectedly"))).toBe("socket closed")
  expect(transientFailureReason(new Error("fetch failed"))).toBe("fetch failed")
  expect(transientFailureReason(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }))).toBe("ECONNRESET")
})

test("ECONNREFUSED is not transient", () => {
  expect(isTransientDelegateFailure(Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" }), liveDog)).toBe(false)
  expect(isTransientDelegateFailure(new Error("fetch failed: connect ECONNREFUSED"), liveDog)).toBe(false)
})

test("auth failures are not transient", () => {
  expect(isTransientDelegateFailure(new Error('sidekick provider "grok" sign-in expired — run /login to re-authenticate.'), liveDog)).toBe(false)
  expect(isTransientDelegateFailure(new Error("codex: not logged in (run /login)"), liveDog)).toBe(false)
  expect(isTransientDelegateFailure(new Error("Broken Custom models endpoint returned 401"), liveDog)).toBe(false)
})

test("stale-runtime errors are not transient even when wrapped", () => {
  expect(isTransientDelegateFailure(new Error("Native CLI binary for darwin-arm64 not found"), liveDog)).toBe(false)
  expect(isTransientDelegateFailure(new Error("run failed", {
    cause: new Error("Native CLI binary for linux-x64 not found"),
  }), liveDog)).toBe(false)
})

test("unrelated model/tool errors are not transient", () => {
  expect(isTransientDelegateFailure(new Error("rate limited"), liveDog)).toBe(false)
  expect(isTransientDelegateFailure(new Error("tool bash failed: exit 1"), liveDog)).toBe(false)
  expect(isTransientDelegateFailure(null, liveDog)).toBe(false)
})

test("aborted is transient only when neither parent nor a non-watchdog abort explains it", () => {
  expect(isTransientDelegateFailure(new DOMException("The operation was aborted.", "AbortError"), liveDog)).toBe(true)
  expect(isTransientDelegateFailure(new Error("aborted"), parentAbortedDog)).toBe(false)
  expect(isTransientDelegateFailure(new Error("aborted"), parentAbortedDog, { userAborted: true })).toBe(false)
  expect(isTransientDelegateFailure(new Error("aborted"), timedOutDog)).toBe(true)
  expect(isTransientDelegateFailure(new Error("aborted"), liveDog, { userAborted: true })).toBe(false)
})

test("user interrupt is never transient even if the message looks like a socket drop", () => {
  expect(isTransientDelegateFailure(
    new Error("The socket connection was closed unexpectedly"),
    liveDog,
    { userAborted: true },
  )).toBe(false)
  expect(isTransientDelegateFailure(new Error("inactivity watchdog"), timedOutDog, { userAborted: true })).toBe(false)
})

test("shouldRetryDelegate is first-attempt only and never retries a user abort", () => {
  expect(shouldRetryDelegate({ attempt: 0, transient: true, userAborted: false })).toBe(true)
  expect(shouldRetryDelegate({ attempt: 1, transient: true, userAborted: false })).toBe(false)
  expect(shouldRetryDelegate({ attempt: 2, transient: true, userAborted: false })).toBe(false)
  expect(shouldRetryDelegate({ attempt: 0, transient: false, userAborted: false })).toBe(false)
  expect(shouldRetryDelegate({ attempt: 0, transient: true, userAborted: true })).toBe(false)
  expect(shouldRetryDelegate({ attempt: 0, transient: false, userAborted: true })).toBe(false)
  expect(shouldRetryDelegate({ attempt: 1, transient: true, userAborted: true })).toBe(false)
})

test("retry decision loop retries a transport drop once and never a user abort", async () => {
  async function runWithRetry(opts: {
    failures: unknown[]
    userAbortedOn?: number
    dogFor?: (attempt: number) => { timedOut: () => boolean; abort: { signal: { aborted: boolean } } }
  }): Promise<{ result: string; attempts: number; notices: string[] }> {
    const notices: string[] = []
    let attempts = 0
    for (let attempt = 0; attempt < 2; attempt++) {
      attempts++
      const err = opts.failures[attempt]
      if (err === undefined) return { result: "ok", attempts, notices }
      const userAborted = opts.userAbortedOn === attempt
      const dog = opts.dogFor?.(attempt) ?? liveDog
      const transient = isTransientDelegateFailure(err, dog, { userAborted })
      if (!shouldRetryDelegate({ attempt, transient, userAborted })) {
        const prefix = attempt === 0 ? "error" : "error (after 1 retry)"
        const message = dog.timedOut() ? "watchdog" : ((err as Error)?.message ?? String(err))
        return { result: `${prefix}: ${message}`, attempts, notices }
      }
      notices.push(`transport failure (${transientFailureReason(err, dog)}) — retrying once`)
    }
    throw new Error("unreachable: more than one retry")
  }

  const recovered = await runWithRetry({
    failures: [new Error("Received empty response from chat model call.")],
  })
  expect(recovered).toEqual({
    result: "ok",
    attempts: 2,
    notices: ["transport failure (empty response) — retrying once"],
  })

  const exhausted = await runWithRetry({
    failures: [
      new Error("The socket connection was closed unexpectedly"),
      new Error("fetch failed"),
    ],
  })
  expect(exhausted.result).toBe("error (after 1 retry): fetch failed")
  expect(exhausted.attempts).toBe(2)
  expect(exhausted.notices).toEqual(["transport failure (socket closed) — retrying once"])

  const interrupted = await runWithRetry({
    failures: [new DOMException("The operation was aborted.", "AbortError")],
    userAbortedOn: 0,
    dogFor: () => parentAbortedDog,
  })
  expect(interrupted).toEqual({
    result: "error: The operation was aborted.",
    attempts: 1,
    notices: [],
  })

  const auth = await runWithRetry({
    failures: [new Error("grok: sign-in expired — run /login")],
  })
  expect(auth.attempts).toBe(1)
  expect(auth.result).toContain("error: grok: sign-in expired")

  expect(DELEGATE_TRANSPORT_RETRY_PROMPT).toContain("continue idempotently")
})
