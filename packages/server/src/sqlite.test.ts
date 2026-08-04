import { describe, expect, test } from "bun:test"
import { retrySqliteBusy } from "./sqlite.ts"

describe("retrySqliteBusy", () => {
  test("backs off through the provided non-spinning waiter", () => {
    const delays: number[] = []
    let calls = 0

    const result = retrySqliteBusy(() => {
      calls++
      if (calls < 3) throw new Error("SQLITE_BUSY")
      return "done"
    }, 4, (delay) => delays.push(delay))

    expect(result).toBe("done")
    expect(calls).toBe(3)
    expect(delays).toEqual([10, 20])
  })

  test("does not wait or retry unrelated failures", () => {
    const delays: number[] = []
    const error = new Error("broken query")

    expect(() => retrySqliteBusy(() => { throw error }, 4, (delay) => delays.push(delay))).toThrow(error)
    expect(delays).toEqual([])
  })

  test("uses the default non-spinning waiter", () => {
    let calls = 0
    const startedAt = performance.now()

    expect(retrySqliteBusy(() => {
      calls++
      if (calls === 1) throw new Error("SQLITE_BUSY")
      return "done"
    }, 2)).toBe("done")

    expect(calls).toBe(2)
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(8)
  })
})
