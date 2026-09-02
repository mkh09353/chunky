import { describe, expect, test } from "bun:test"
import {
  DEFAULT_REPLAY_MAX_BYTES,
  DEFAULT_REPLAY_MAX_EVENTS,
  REPLAY_MAX_BYTES_ENV,
  REPLAY_MAX_EVENTS_ENV,
  parsePositiveInteger,
  readReplayBudget,
  replayExceedsBudget,
} from "./replay-budget.ts"

describe("parsePositiveInteger", () => {
  test("accepts plain positive integers, trimming whitespace", () => {
    expect(parsePositiveInteger("1", 9)).toBe(1)
    expect(parsePositiveInteger(" 2000 ", 9)).toBe(2000)
    expect(parsePositiveInteger("8388608", 9)).toBe(8388608)
  })

  test("falls back for missing, zero, negative, fractional, exponent, hex, or junk values", () => {
    for (const raw of [undefined, null, "", "   ", "0", "-5", "+5", "1.5", "1e3", "0x10", "abc", "12abc", "NaN", "Infinity"]) {
      expect(parsePositiveInteger(raw, 42)).toBe(42)
    }
  })

  test("falls back beyond the safe-integer range", () => {
    expect(parsePositiveInteger("9007199254740991", 1)).toBe(9007199254740991)
    expect(parsePositiveInteger("9007199254740992", 1)).toBe(1)
    expect(parsePositiveInteger("99999999999999999999", 1)).toBe(1)
  })
})

describe("readReplayBudget", () => {
  test("uses the documented defaults when the env is empty", () => {
    expect(readReplayBudget({})).toEqual({ maxEvents: 2000, maxBytes: 8388608 })
    expect(DEFAULT_REPLAY_MAX_EVENTS).toBe(2000)
    expect(DEFAULT_REPLAY_MAX_BYTES).toBe(8388608)
  })

  test("honors CHUNKY_REPLAY_MAX_EVENTS and CHUNKY_REPLAY_MAX_BYTES", () => {
    expect(REPLAY_MAX_EVENTS_ENV).toBe("CHUNKY_REPLAY_MAX_EVENTS")
    expect(REPLAY_MAX_BYTES_ENV).toBe("CHUNKY_REPLAY_MAX_BYTES")
    expect(readReplayBudget({ CHUNKY_REPLAY_MAX_EVENTS: "3", CHUNKY_REPLAY_MAX_BYTES: "1024" })).toEqual({ maxEvents: 3, maxBytes: 1024 })
  })

  test("each variable falls back independently on invalid input", () => {
    expect(readReplayBudget({ CHUNKY_REPLAY_MAX_EVENTS: "-1", CHUNKY_REPLAY_MAX_BYTES: "10" })).toEqual({ maxEvents: 2000, maxBytes: 10 })
    expect(readReplayBudget({ CHUNKY_REPLAY_MAX_EVENTS: "7", CHUNKY_REPLAY_MAX_BYTES: "lots" })).toEqual({ maxEvents: 7, maxBytes: 8388608 })
  })
})

describe("replayExceedsBudget", () => {
  const budget = { maxEvents: 3, maxBytes: 100 }

  test("ranges at or under both limits are allowed", () => {
    expect(replayExceedsBudget({ events: 0, bytes: 0 }, budget)).toBe(false)
    expect(replayExceedsBudget({ events: 3, bytes: 100 }, budget)).toBe(false)
  })

  test("exceeding either limit refuses the replay", () => {
    expect(replayExceedsBudget({ events: 4, bytes: 0 }, budget)).toBe(true)
    expect(replayExceedsBudget({ events: 1, bytes: 101 }, budget)).toBe(true)
    expect(replayExceedsBudget({ events: 4, bytes: 101 }, budget)).toBe(true)
  })
})
